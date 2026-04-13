import { Contract, EventFilter } from "ethers";
import {
  fillStatusArray,
  findDepositBlock,
  getMaxFillDeadlineInRange as getMaxFillDeadline,
  getTimeAt as _getTimeAt,
  relayFillStatus,
  getTimestampForBlock as _getTimestampForBlock,
} from "../../arch/evm";
import {
  relayFillStatus as relayFillStatusTvm,
  getMaxFillDeadlineInRange as getMaxFillDeadlineTvm,
  getTimeAt as _getTimeAtTvm,
  findDepositBlock as findDepositBlockTvm,
} from "../../arch/tvm";
import { DepositWithBlock, FillStatus, Log, RelayData } from "../../interfaces";
import {
  BigNumber,
  DepositSearchResult,
  getNetworkName,
  InvalidFill,
  MakeOptional,
  toBN,
  EvmAddress,
  unpackDepositEvent,
  chainIsTvm,
} from "../../utils";
import {
  EventSearchConfig,
  logToSortableEvent,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
  spreadEventWithBlockNumber,
} from "../../utils/EventUtils";
import { isUpdateFailureReason } from "../BaseAbstractClient";
import { knownEventNames, SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
import winston from "winston";
import { HubPoolClient } from "../HubPoolClient";
import { EVM_SPOKE_POOL_CLIENT_TYPE } from "./types";

/**
 * An EVM-specific SpokePoolClient.
 */
export class EVMSpokePoolClient extends SpokePoolClient {
  readonly type = EVM_SPOKE_POOL_CLIENT_TYPE;
  readonly tvm: boolean;

  constructor(
    logger: winston.Logger,
    public readonly spokePool: Contract,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentBlock: number,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 }
  ) {
    super(logger, hubPoolClient, chainId, deploymentBlock, eventSearchConfig);
    this.spokePoolAddress = EvmAddress.from(spokePool.address);
    this.tvm = chainIsTvm(this.chainId);
  }

  public override relayFillStatus(relayData: RelayData, atHeight?: number): Promise<FillStatus> {
    const fillStatusHandler = this.tvm ? relayFillStatusTvm : relayFillStatus;
    return fillStatusHandler(this.spokePool, relayData, atHeight, this.chainId);
  }

  public override fillStatusArray(relayData: RelayData[], atHeight?: number): Promise<(FillStatus | undefined)[]> {
    return fillStatusArray(this.spokePool, relayData, atHeight);
  }

  public override getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    const maxFillDeadlineInRangeHandler = this.tvm ? getMaxFillDeadlineTvm : getMaxFillDeadline;
    return maxFillDeadlineInRangeHandler(this.spokePool, startBlock, endBlock);
  }

  private _availableEventsOnSpoke(eventNames: string[] = knownEventNames): { [eventName: string]: EventFilter } {
    return Object.fromEntries(
      this.spokePool.interface.fragments
        .filter(({ name, type }) => type === "event" && eventNames.includes(name))
        .map(({ name }) => [name, this.spokePool.filters[name]()])
    );
  }

  public override _queryableEventNames(): string[] {
    return Object.keys(this._availableEventsOnSpoke(knownEventNames));
  }

  /**
   * Retrieve the on-chain time at a specific block.
   * EVM reads SpokePool.getCurrentTime() via multicall with a historical blockTag.
   * @param blockNumber The block number to query.
   * @returns The on-chain time as a number.
   */
  protected async _getCurrentTime(blockNumber: number): Promise<number> {
    if (this.tvm) {
      const block = await this.spokePool.provider.getBlock(blockNumber);
      const currentTime = block.timestamp;
      if (currentTime < this.currentTime) {
        throw new Error(`EVMSpokePoolClient::_getCurrentTimeTvm: currentTime: ${currentTime} < ${this.currentTime}`);
      }
      return currentTime;
    }
    const { spokePool } = this;
    const multicallFunctions = ["getCurrentTime"];
    const multicallOutput = await spokePool.callStatic.multicall(
      multicallFunctions.map((f) => spokePool.interface.encodeFunctionData(f)),
      { blockTag: blockNumber }
    );

    const [currentTime] = multicallFunctions.map(
      (fn, idx) => spokePool.interface.decodeFunctionResult(fn, multicallOutput[idx])[0]
    );

    if (!BigNumber.isBigNumber(currentTime) || currentTime.lt(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`EVMSpokePoolClient::update: ${errMsg}`);
    }

    return currentTime.toNumber();
  }

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

      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `eventSearchConfig` passed in during instantiation.
      // However, certain events have special overriding requirements to their search ranges:
      // - EnabledDepositRoute: The full history is always required, so override the requested fromBlock.
      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.from = this.deploymentBlock;
      }

      return {
        filter: this._availableEventsOnSpoke()[eventName],
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
    const [currentTime, ...events] = await Promise.all([
      this._getCurrentTime(searchConfig.to),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    if (currentTime < this.currentTime) {
      throw new Error(`EVMSpokePoolClient::update: currentTime: ${currentTime} < ${this.currentTime}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    events.forEach((events) => sortEventsAscendingInPlace(events.map(logToSortableEvent)));

    // Map events to SortableEvent
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

  public override getTimeAt(blockNumber: number): Promise<number> {
    const getTimeAtHandler = this.tvm ? _getTimeAtTvm : _getTimeAt;
    return getTimeAtHandler(this.spokePool, blockNumber);
  }

  public override async findDeposit(depositId: BigNumber): Promise<DepositSearchResult> {
    let deposit = this.getDeposit(depositId);
    if (deposit) {
      return { found: true, deposit };
    }

    // No deposit found; revert to searching for it.
    const result = await this.queryDepositEvents(depositId);

    if ("reason" in result) {
      return { found: false, code: InvalidFill.DepositIdNotFound, reason: result.reason };
    }

    const { event, elapsedMs } = result;

    const partialDeposit = unpackDepositEvent(spreadEventWithBlockNumber(event), this.chainId);
    const quoteBlockNumber = await this.getBlockNumber(partialDeposit.quoteTimestamp);
    const outputToken = partialDeposit.outputToken.isZeroAddress()
      ? this.getDestinationTokenForDeposit({ ...partialDeposit, quoteBlockNumber })
      : partialDeposit.outputToken;

    deposit = {
      ...partialDeposit,
      outputToken,
      quoteBlockNumber,
      fromLiteChain: this.isOriginLiteChain(partialDeposit),
      toLiteChain: this.isDestinationLiteChain(partialDeposit),
    } satisfies DepositWithBlock;

    this.logger.debug({
      at: "SpokePoolClient#findDeposit",
      message: "Located deposit outside of SpokePoolClient's search range",
      deposit,
      elapsedMs,
    });
    return { found: true, deposit };
  }

  public override getTimestampForBlock(blockNumber: number): Promise<number> {
    return _getTimestampForBlock(this.spokePool.provider, blockNumber);
  }

  /**
   * Find the block at which a deposit was created.
   * EVM uses a binary-search over historical numberOfDeposits().
   * TVM overrides this with an event-based lookup.
   */
  protected _findDepositBlock(depositId: BigNumber, lowBlock: number, highBlock?: number): Promise<number | undefined> {
    const findDepositBlockHandler = this.tvm ? findDepositBlockTvm : findDepositBlock;
    return findDepositBlockHandler(this.spokePool, depositId, lowBlock, highBlock);
  }

  protected async queryDepositEvents(
    depositId: BigNumber
  ): Promise<{ event: Log; elapsedMs: number } | { reason: string }> {
    const tStart = Date.now();
    const upperBound = this.latestHeightSearched || undefined;
    const from = await this._findDepositBlock(depositId, this.deploymentBlock, upperBound);
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
}
