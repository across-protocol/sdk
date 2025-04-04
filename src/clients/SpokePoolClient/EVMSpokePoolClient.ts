import { Contract, EventFilter } from "ethers";
import {
  fillStatusArray,
  findDepositBlock,
  getMaxFillDeadlineInRange as getMaxFillDeadline,
  getTimeAt as _getTimeAt,
  relayFillStatus,
  getTimestampForBlock as _getTimestampForBlock,
} from "../../arch/evm";
import { DepositWithBlock, FillStatus, RelayData } from "../../interfaces";
import {
  BigNumber,
  DepositSearchResult,
  getNetworkName,
  InvalidFill,
  isZeroAddress,
  MakeOptional,
  toBN,
} from "../../utils";
import {
  EventSearchConfig,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
  spreadEventWithBlockNumber,
} from "../../utils/EventUtils";
import { isUpdateFailureReason } from "../BaseAbstractClient";
import { knownEventNames, SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
import winston from "winston";
import { HubPoolClient } from "../HubPoolClient";

/**
 * An EVM-specific SpokePoolClient.
 */
export class EVMSpokePoolClient extends SpokePoolClient {
  constructor(
    logger: winston.Logger,
    public readonly spokePool: Contract,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentBlock: number,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super(logger, hubPoolClient, chainId, deploymentBlock, eventSearchConfig);
  }

  public override relayFillStatus(relayData: RelayData, blockTag?: number | "latest"): Promise<FillStatus> {
    return relayFillStatus(this.spokePool, relayData, blockTag, this.chainId);
  }

  public override fillStatusArray(relayData: RelayData[], blockTag?: number | "latest"): Promise<FillStatus> {
    return fillStatusArray(this.spokePool, relayData, blockTag);
  }

  public override getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    return getMaxFillDeadline(this.spokePool, startBlock, endBlock);
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
        _searchConfig.fromBlock = this.deploymentBlock;
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
    const multicallFunctions = ["getCurrentTime"];
    const [multicallOutput, ...events] = await Promise.all([
      spokePool.callStatic.multicall(
        multicallFunctions.map((f) => spokePool.interface.encodeFunctionData(f)),
        { blockTag: searchConfig.toBlock }
      ),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    const [currentTime] = multicallFunctions.map(
      (fn, idx) => spokePool.interface.decodeFunctionResult(fn, multicallOutput[idx])[0]
    );

    if (!BigNumber.isBigNumber(currentTime) || currentTime.lt(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`SpokePoolClient::update: ${errMsg}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    events.forEach((events) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: currentTime.toNumber(), // uint32
      searchEndBlock: searchConfig.toBlock,
      events,
    };
  }

  public override getTimeAt(blockNumber: number): Promise<number> {
    return _getTimeAt(this.spokePool, blockNumber);
  }

  public override async findDeposit(depositId: BigNumber): Promise<DepositSearchResult> {
    let deposit = this.getDeposit(depositId);
    if (deposit) {
      return { found: true, deposit };
    }

    // No deposit found; revert to searching for it.
    const upperBound = this.latestBlockSearched || undefined; // Don't permit block 0 as the high block.
    const fromBlock = await findDepositBlock(this.spokePool, depositId, this.deploymentBlock, upperBound);
    const chain = getNetworkName(this.chainId);
    if (!fromBlock) {
      const reason =
        `Unable to find ${chain} depositId ${depositId}` +
        ` within blocks [${this.deploymentBlock}, ${upperBound ?? "latest"}].`;
      return { found: false, code: InvalidFill.DepositIdNotFound, reason };
    }

    const toBlock = fromBlock;
    const tStart = Date.now();
    // Check both V3FundsDeposited and FundsDeposited events to look for a specified depositId.
    const { maxBlockLookBack } = this.eventSearchConfig;
    const query = (
      await Promise.all([
        paginatedEventQuery(
          this.spokePool,
          this.spokePool.filters.V3FundsDeposited(null, null, null, null, null, depositId),
          { fromBlock, toBlock, maxBlockLookBack }
        ),
        paginatedEventQuery(
          this.spokePool,
          this.spokePool.filters.FundsDeposited(null, null, null, null, null, depositId),
          { fromBlock, toBlock, maxBlockLookBack }
        ),
      ])
    ).flat();
    const tStop = Date.now();

    const event = query.find(({ args }) => args["depositId"].eq(depositId));
    if (event === undefined) {
      return {
        found: false,
        code: InvalidFill.DepositIdNotFound,
        reason: `${chain} depositId ${depositId} not found at block ${fromBlock}.`,
      };
    }

    deposit = {
      ...spreadEventWithBlockNumber(event),
      originChainId: this.chainId,
      quoteBlockNumber: await this.getBlockNumber(Number(event.args["quoteTimestamp"])),
      fromLiteChain: true, // To be updated immediately afterwards.
      toLiteChain: true, // To be updated immediately afterwards.
    } as DepositWithBlock;

    if (isZeroAddress(deposit.outputToken)) {
      deposit.outputToken = this.getDestinationTokenForDeposit(deposit);
    }
    deposit.fromLiteChain = this.isOriginLiteChain(deposit);
    deposit.toLiteChain = this.isDestinationLiteChain(deposit);

    this.logger.debug({
      at: "SpokePoolClient#findDeposit",
      message: "Located V3 deposit outside of SpokePoolClient's search range",
      deposit,
      elapsedMs: tStop - tStart,
    });

    return { found: true, deposit };
  }

  public override getTimestampForBlock(blockNumber: number): Promise<number> {
    return _getTimestampForBlock(this.spokePool.provider, blockNumber);
  }
}
