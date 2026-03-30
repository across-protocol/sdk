import {
  findDepositBlock,
  getMaxFillDeadlineInRange as getMaxFillDeadline,
  getTimeAt as _getTimeAt,
  relayFillStatus,
} from "../../arch/tvm";
import { FillStatus, Log, RelayData } from "../../interfaces";
import { BigNumber, getNetworkName, paginatedEventQuery, sortEventsAscendingInPlace } from "../../utils";
import { logToSortableEvent, spreadEventWithBlockNumber } from "../../utils/EventUtils";
import { isUpdateFailureReason } from "../BaseAbstractClient";
import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { SpokePoolUpdate } from "./SpokePoolClient";
import { TVM_SPOKE_POOL_CLIENT_TYPE } from "./types";

/**
 * A TVM-specific SpokePoolClient for TRON.
 *
 * TRON is EVM-compatible for reads and event queries, but diverges in three areas:
 * 1. No historical `eth_call` — only "latest" blockTag is accepted.
 * 2. No `eth_sendRawTransaction` — TRON uses Protobuf-encoded transactions via TronWeb.
 * 3. Energy/bandwidth fee model instead of gas.
 *
 * This client extends EVMSpokePoolClient, overriding only the methods affected by (1).
 * Transaction submission (2) and fee estimation (3) are handled by the arch/tvm utilities.
 */
export class TVMSpokePoolClient extends EVMSpokePoolClient {
  // @ts-expect-error: Narrowing the base class literal type from "EVM" to "TVM".
  override readonly type = TVM_SPOKE_POOL_CLIENT_TYPE;

  public override relayFillStatus(relayData: RelayData, atHeight?: number): Promise<FillStatus> {
    return relayFillStatus(this.spokePool, relayData, atHeight, this.chainId);
  }

  public override getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    return getMaxFillDeadline(this.spokePool, startBlock, endBlock);
  }

  public override getTimeAt(blockNumber: number): Promise<number> {
    return _getTimeAt(this.spokePool, blockNumber);
  }

  /**
   * Override queryDepositEvents to use TVM's event-based findDepositBlock
   * instead of EVM's binary-search over historical numberOfDeposits().
   */
  protected override async queryDepositEvents(
    depositId: BigNumber
  ): Promise<{ event: Log; elapsedMs: number } | { reason: string }> {
    const tStart = Date.now();
    const upperBound = this.latestHeightSearched || undefined;
    const from = await findDepositBlock(this.spokePool, depositId, this.deploymentBlock, upperBound);
    const chain = getNetworkName(this.chainId);

    if (!from) {
      return {
        reason: `Unable to find ${chain} depositId ${depositId} within blocks [${this.deploymentBlock}, ${
          upperBound ?? "latest"
        }].`,
      };
    }

    const to = from;

    const { maxLookBack } = this.eventSearchConfig;
    const events = (
      await Promise.all([
        paginatedEventQuery(
          this.spokePool,
          this.spokePool.filters.V3FundsDeposited(null, null, null, null, null, depositId),
          { from, to, maxLookBack }
        ),
        paginatedEventQuery(
          this.spokePool,
          this.spokePool.filters.FundsDeposited(null, null, null, null, null, depositId),
          { from, to, maxLookBack }
        ),
      ])
    )
      .flat()
      .filter(({ args }) => args["depositId"].eq(depositId));

    const tStop = Date.now();
    const [event] = events;
    if (!event) {
      return {
        reason: `Unable to find ${chain} depositId ${depositId} within blocks [${from}, ${upperBound ?? "latest"}].`,
      };
    }

    return { event, elapsedMs: tStop - tStart };
  }

  /**
   * Override _update to avoid historical eth_call for getCurrentTime.
   * TRON does not support eth_call with historical blockTags, so we
   * use the block timestamp from provider.getBlock() instead of
   * SpokePool.getCurrentTime({ blockTag: searchConfig.to }).
   */
  protected override async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    const searchConfig = await this.updateSearchConfig(this.spokePool.provider);
    if (isUpdateFailureReason(searchConfig)) {
      const reason = searchConfig;
      return { success: false, reason };
    }

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!this._queryableEventNames().includes(eventName)) {
        throw new Error(`SpokePoolClient: Cannot query unrecognised SpokePool event name: ${eventName}`);
      }

      const _searchConfig = { ...searchConfig };

      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.from = this.deploymentBlock;
      }

      return {
        filter: this.spokePool.filters[eventName](),
        searchConfig: _searchConfig,
      };
    });

    const { spokePool } = this;
    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: spokePool.address,
    });

    const timerStart = Date.now();

    // TRON does not support historical eth_call, so instead of multicall({ blockTag }),
    // retrieve the block timestamp from the provider directly.
    const [block, ...events] = await Promise.all([
      spokePool.provider.getBlock(searchConfig.to),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    const currentTime = block.timestamp;
    if (currentTime < this.currentTime) {
      throw new Error(`TVMSpokePoolClient::update: currentTime: ${currentTime} < ${this.currentTime}`);
    }

    events.forEach((events) => sortEventsAscendingInPlace(events.map(logToSortableEvent)));

    const eventsWithBlockNumber = events.map((eventList) =>
      eventList.map((event) => spreadEventWithBlockNumber(event))
    );

    return {
      success: true,
      currentTime,
      searchEndBlock: searchConfig.to,
      events: eventsWithBlockNumber,
    };
  }
}
