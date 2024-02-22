import { BigNumber, Contract, Event, EventFilter, ethers } from "ethers";
import { groupBy } from "lodash";
import winston from "winston";
import {
  AnyObject,
  bnZero,
  DefaultLogLevels,
  EventSearchConfig,
  MAX_BIG_INT,
  MakeOptional,
  assign,
  getDepositOutputAmount,
  getFillOutputAmount,
  getRelayDataHash,
  getTotalFilledAmount,
  isDefined,
  isV2Deposit,
  isV2SpeedUp,
  isV3SpeedUp,
  toBN,
} from "../utils";
import {
  paginatedEventQuery,
  sortEventsAscending,
  sortEventsAscendingInPlace,
  spreadEvent,
  spreadEventWithBlockNumber,
} from "../utils/EventUtils";
import { filledSameDeposit, validateFillForDeposit } from "../utils/FlowUtils";

import { ZERO_ADDRESS } from "../constants";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillWithBlock,
  FilledRelayEvent,
  FilledV3RelayEvent,
  FundsDepositedEvent,
  RealizedLpFee,
  RelayerRefundExecutionWithBlock,
  RootBundleRelayWithBlock,
  SlowFillRequestWithBlock,
  SpeedUp,
  TokensBridged,
  V2Deposit,
  V2DepositWithBlock,
  V2Fill,
  V2FillWithBlock,
  V2SpeedUp,
  V3DepositWithBlock,
  V3FillWithBlock,
  V3FundsDepositedEvent,
  V3RelayData,
  V3SpeedUp,
} from "../interfaces";
import { SpokePool } from "../typechain";
import { getNetworkName } from "../utils/NetworkUtils";
import { getBlockRangeForDepositId, getDepositIdAtBlock } from "../utils/SpokeUtils";
import { BaseAbstractClient } from "./BaseAbstractClient";
import { HubPoolClient } from "./HubPoolClient";

type _SpokePoolUpdate = {
  success: boolean;
  currentTime: number;
  oldestTime: number;
  firstDepositId: number;
  latestDepositId: number;
  events: Event[][];
  searchEndBlock: number;
};
export type SpokePoolUpdate = { success: false } | _SpokePoolUpdate;

/**
 * SpokePoolClient is a client for the SpokePool contract. It is responsible for querying the SpokePool contract
 * for events and storing them in memory. It also provides some convenience methods for querying the stored events.
 */
export class SpokePoolClient extends BaseAbstractClient {
  protected currentTime = 0;
  protected oldestTime = 0;
  protected depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  protected depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  protected speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  protected slowFillRequests: { [relayDataHash: string]: SlowFillRequestWithBlock } = {};
  protected depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  protected tokensBridged: TokensBridged[] = [];
  protected rootBundleRelays: RootBundleRelayWithBlock[] = [];
  protected relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  protected earlyDeposits: FundsDepositedEvent[] = [];
  protected queryableEventNames: string[] = [];
  public earliestDepositIdQueried = Number.MAX_SAFE_INTEGER;
  public latestDepositIdQueried = 0;
  public firstDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public lastDepositIdForSpokePool = Number.MAX_SAFE_INTEGER;
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};

  /**
   * Creates a new SpokePoolClient.
   * @param logger A logger instance.
   * @param spokePool The SpokePool contract instance that this client will query.
   * @param hubPoolClient An optional HubPoolClient instance. This is used to fetch spoke data that is not stored on the SpokePool contract but is stored on the HubPool contract.
   * @param chainId The chain ID of the chain that this client is querying.
   * @param deploymentBlock The block number that the SpokePool contract was deployed at.
   * @param eventSearchConfig An optional EventSearchConfig object that controls how far back in history the client will search for events. If not provided, the client will only search for events from the deployment block.
   */
  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    // Can be excluded. This disables some deposit validation.
    readonly hubPoolClient: HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super();
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.latestBlockSearched = 0;
    this.queryableEventNames = Object.keys(this._queryableEventNames());
  }

  public _queryableEventNames(): { [eventName: string]: EventFilter } {
    const knownEventNames = [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "TokensBridged",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
      "V3FundsDeposited",
      "RequestedSpeedUpV3Deposit",
      "RequestedV3SlowFill",
      "FilledV3Relay",
    ];
    return Object.fromEntries(
      this.spokePool.interface.fragments
        .filter(({ name, type }) => type === "event" && knownEventNames.includes(name))
        .map(({ name }) => [name, this.spokePool.filters[name]()])
    );
  }

  /**
   * Retrieves a list of deposits from the SpokePool contract destined for the given destination chain ID.
   * @param destinationChainId The destination chain ID.
   * @returns A list of deposits.
   */
  public getDepositsForDestinationChain(destinationChainId: number): DepositWithBlock[] {
    return Object.values(this.depositHashes).filter((deposit) => deposit.destinationChainId === destinationChainId);
  }

  /**
   * Retrieves a list of deposits from the SpokePool contract that are associated with this spoke pool.
   * @returns A list of deposits.
   * @note This method returns all deposits, regardless of destination chain ID in sorted order.
   */
  public getDeposits(filter?: { fromBlock: number; toBlock: number }): DepositWithBlock[] {
    let deposits = Object.values(this.depositHashes);
    if (isDefined(filter)) {
      const { fromBlock, toBlock } = filter;
      deposits = deposits.filter(({ blockNumber }) => blockNumber >= fromBlock && toBlock >= blockNumber);
    }

    return sortEventsAscendingInPlace(deposits);
  }

  /**
   * Retrieves a list of the tokens that have been bridged.
   * @returns A list of tokens.
   */
  public getTokensBridged(): TokensBridged[] {
    return this.tokensBridged;
  }

  /**
   * Retrieves a mapping of tokens and their associated destination chain IDs that can be bridged.
   * @returns A mapping of tokens and their associated destination chain IDs in a nested mapping.
   */
  public getDepositRoutes(): { [originToken: string]: { [DestinationChainId: number]: boolean } } {
    return this.depositRoutes;
  }

  /**
   * Determines whether a deposit route is enabled for the given origin token and destination chain ID.
   * @param originToken The origin token address.
   * @param destinationChainId The destination chain ID.
   * @returns True if the deposit route is enabled, false otherwise.
   */
  public isDepositRouteEnabled(originToken: string, destinationChainId: number): boolean {
    return this.depositRoutes[originToken]?.[destinationChainId] ?? false;
  }

  /**
   * Retrieves a list of all the available origin tokens that can be bridged.
   * @returns A list of origin tokens.
   */
  public getAllOriginTokens(): string[] {
    return Object.keys(this.depositRoutes);
  }

  /**
   * Retrieves a list of fills from the SpokePool contract.
   * @returns A list of fills.
   */
  public getFills(): FillWithBlock[] {
    return sortEventsAscendingInPlace(Object.values(this.fills).flat());
  }

  /**
   * Retrieves a list of fills from a specific origin chain ID.
   * @param originChainId The origin chain ID.
   * @returns A list of fills.
   */
  public getFillsForOriginChain(originChainId: number): FillWithBlock[] {
    return this.fills[originChainId] || [];
  }

  /**
   * Retrieves a list of fills from a specific relayer address.
   * @param relayer The relayer address.
   * @returns A list of fills.
   */
  public getFillsForRelayer(relayer: string): FillWithBlock[] {
    return this.getFills().filter((fill) => fill.relayer === relayer);
  }

  /**
   * Retrieves a list of fills from a given block range.
   * @param startingBlock The starting block number.
   * @param endingBlock The ending block number.
   * @returns A list of fills.
   */
  public getFillsWithBlockInRange(startingBlock: number, endingBlock: number): FillWithBlock[] {
    return this.getFills().filter((fill) => fill.blockNumber >= startingBlock && fill.blockNumber <= endingBlock);
  }

  /**
   * Retrieves a list of root bundle relays from the SpokePool contract.
   * @returns A list of root bundle relays.
   */
  public getRootBundleRelays(): RootBundleRelayWithBlock[] {
    return this.rootBundleRelays;
  }

  /**
   * Retrieves the ID of the latest root bundle.
   * @returns The ID of the latest root bundle. This will be 0 if no root bundles have been relayed.
   */
  public getLatestRootBundleId(): number {
    return this.rootBundleRelays.length > 0
      ? this.rootBundleRelays[this.rootBundleRelays.length - 1]?.rootBundleId + 1
      : 0;
  }

  /**
   * Retrieves a list of relayer refund executions from the SpokePool contract.
   * @returns A list of relayer refund executions.
   */
  public getRelayerRefundExecutions(): RelayerRefundExecutionWithBlock[] {
    return this.relayerRefundExecutions;
  }

  /**
   * Retrieves a mapping of token addresses to relayer addresses to the amount of refunds that have been executed.
   * @returns A mapping of token addresses to relayer addresses to the amount of refunds that have been executed.
   */
  public getExecutedRefunds(relayerRefundRoot: string): {
    [tokenAddress: string]: {
      [relayer: string]: BigNumber;
    };
  } {
    const bundle = this.getRootBundleRelays().find((bundle) => bundle.relayerRefundRoot === relayerRefundRoot);
    if (bundle === undefined) {
      return {};
    }

    const executedRefundLeaves = this.getRelayerRefundExecutions().filter(
      (leaf) => leaf.rootBundleId === bundle.rootBundleId
    );
    const executedRefunds: { [tokenAddress: string]: { [relayer: string]: BigNumber } } = {};
    for (const refundLeaf of executedRefundLeaves) {
      const tokenAddress = refundLeaf.l2TokenAddress;
      if (executedRefunds[tokenAddress] === undefined) {
        executedRefunds[tokenAddress] = {};
      }
      const executedTokenRefunds = executedRefunds[tokenAddress];

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i];
        const refundAmount = refundLeaf.refundAmounts[i];
        if (executedTokenRefunds[relayer] === undefined) {
          executedTokenRefunds[relayer] = ethers.constants.Zero;
        }
        executedTokenRefunds[relayer] = executedTokenRefunds[relayer].add(refundAmount);
      }
    }
    return executedRefunds;
  }

  /**
   * Appends a speed up signature to a specific deposit.
   * @param deposit The deposit to append the speed up signature to.
   * @returns A new deposit instance with the speed up signature appended to the deposit.
   */
  public appendMaxSpeedUpSignatureToDeposit(deposit: DepositWithBlock): DepositWithBlock {
    const { depositId, depositor } = deposit;
    const depositorSpeedUps = this.speedUps[depositor]?.[depositId];
    if (!isDefined(depositorSpeedUps)) {
      return deposit;
    }

    if (isV2Deposit(deposit)) {
      const v2SpeedUps = depositorSpeedUps.filter(isV2SpeedUp<V2SpeedUp, V3SpeedUp>);
      if (v2SpeedUps.length === 0) {
        return deposit;
      }
      const maxSpeedUp = v2SpeedUps.reduce((prev, current) =>
        prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
      );

      // We assume that the depositor authorises SpeedUps in isolation of each other, which keeps the relayer
      // logic simple: find the SpeedUp with the highest relayerFeePct, and use all of its fields
      if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) {
        return deposit;
      }

      // Return deposit with updated params from the speedup with the highest updated relayer fee pct.
      const updatedDeposit: V2DepositWithBlock = {
        ...deposit,
        speedUpSignature: maxSpeedUp.depositorSignature,
        newRelayerFeePct: maxSpeedUp.newRelayerFeePct,
        updatedRecipient: maxSpeedUp.updatedRecipient,
        updatedMessage: maxSpeedUp.updatedMessage,
      };

      return updatedDeposit;
    }

    const v3SpeedUps = depositorSpeedUps.filter(isV3SpeedUp<V3SpeedUp, V2SpeedUp>);
    if (v3SpeedUps.length === 0) {
      return deposit;
    }
    const maxSpeedUp = v3SpeedUps.reduce((prev, current) =>
      prev.updatedOutputAmount.lt(current.updatedOutputAmount) ? prev : current
    );

    // We assume that the depositor authorises SpeedUps in isolation of each other, which keeps the relayer
    // logic simple: find the SpeedUp with the lowest updatedOutputAmount, and use all of its fields.
    if (maxSpeedUp.updatedOutputAmount.gte(deposit.outputAmount)) {
      return deposit;
    }

    // Return deposit with updated params from the speedup with the lowest updated output amount.
    const updatedDeposit: V3DepositWithBlock = {
      ...deposit,
      speedUpSignature: maxSpeedUp.depositorSignature,
      updatedOutputAmount: maxSpeedUp.updatedOutputAmount,
      updatedRecipient: maxSpeedUp.updatedRecipient,
      updatedMessage: maxSpeedUp.updatedMessage,
    };

    return updatedDeposit;
  }

  /**
   * Find a deposit based on its deposit ID.
   * @notice If evaluating a fill, be sure to verify it against the resulting deposit.
   * @param depositId The unique ID of the deposit being queried.
   * @returns The corresponding deposit if found, undefined otherwise.
   */
  public getDeposit(depositId: number): DepositWithBlock | undefined {
    const depositHash = this.getDepositHash({ depositId, originChainId: this.chainId });
    return this.depositHashes[depositHash];
  }

  /**
   * Find a SlowFillRequested event based on its deposit RelayData.
   * @param relayData RelayData field for the SlowFill request.
   * @returns The corresponding SlowFIllRequest event if found, otherwise undefined.
   */
  public getSlowFillRequest(relayData: V3RelayData): SlowFillRequestWithBlock | undefined {
    const hash = getRelayDataHash(relayData, this.chainId);
    return this.slowFillRequests[hash];
  }

  /**
   * Retrieves a list of slow fill requests for deposits from a specific origin chain ID.
   * @param originChainId The origin chain ID.
   * @returns A list of slow fill requests.
   */
  public getSlowFillRequestsForOriginChain(originChainId: number): SlowFillRequestWithBlock[] {
    return Object.values(this.slowFillRequests).filter(
      (e: SlowFillRequestWithBlock) => e.originChainId === originChainId
    );
  }

  /**
   * Find a corresponding deposit for a given fill.
   * @param fill The fill to find a corresponding deposit for.
   * @returns The corresponding deposit if found, undefined otherwise.
   */
  public getDepositForFill(fill: Fill, fillFieldsToIgnore: string[] = []): DepositWithBlock | undefined {
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    return validateFillForDeposit(fill, depositWithMatchingDepositId, fillFieldsToIgnore)
      ? depositWithMatchingDepositId
      : undefined;
  }

  /**
   * @dev TODO This function is a bit of a hack for now and its dangerous to leave public because it allows the caller to
   * manipulate internal data that was set at update() time. This is a workaround the current structure where UBAClient
   * is dependent on SpokePoolClient, but one of the SpokePoolClient's internal data structures, `deposits` is dependent
   * on the UBA client state being updated in order to have set correct realizedLpFeePcts. This function is currently
   * designed to be called by the UBA client for each deposit that is loaded and have it reset the realizedLpFeePct
   * equal to the depositBalancingFee plus the LP fee.
   */
  public updateDepositRealizedLpFeePct(event: Deposit, realizedLpFeePct: BigNumber): void {
    this.depositHashes[this.getDepositHash(event)] = {
      ...this.depositHashes[this.getDepositHash(event)],
      realizedLpFeePct,
    };
  }

  /**
   * Find the unfilled amount for a given deposit. This is the full deposit amount minus the total filled amount.
   * @param deposit The deposit to find the unfilled amount for.
   * @param fillCount The number of fills that have been applied to this deposit.
   * @param invalidFills The invalid fills that have been applied to this deposit.
   * @returns The unfilled amount.
   */
  public getValidUnfilledAmountForDeposit(deposit: Deposit): {
    unfilledAmount: BigNumber;
    fillCount: number;
    invalidFills: Fill[];
  } {
    const outputAmount = getDepositOutputAmount(deposit);
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: toBN(outputAmount), fillCount: 0, invalidFills: [] };
    }

    const { validFills, invalidFills } = fillsForDeposit.reduce(
      (groupedFills: { validFills: Fill[]; invalidFills: Fill[] }, fill: Fill) => {
        if (validateFillForDeposit(fill, deposit)) {
          groupedFills.validFills.push(fill);
        } else {
          groupedFills.invalidFills.push(fill);
        }
        return groupedFills;
      },
      { validFills: [], invalidFills: [] }
    );

    // Log any invalid deposits with same deposit id but different params.
    const invalidFillsForDeposit = invalidFills.filter((x) => x.depositId === deposit.depositId);
    if (invalidFillsForDeposit.length > 0) {
      this.logger.warn({
        at: "SpokePoolClient",
        chainId: this.chainId,
        message: "Invalid fills found matching deposit ID",
        deposit,
        invalidFills: Object.fromEntries(invalidFillsForDeposit.map((x) => [x.relayer, x])),
        notificationPath: "across-invalid-fills",
      });
    }

    // If all fills are invalid we can consider this unfilled.
    if (validFills.length === 0) {
      return { unfilledAmount: toBN(outputAmount), fillCount: 0, invalidFills };
    }

    // Order fills by totalFilledAmount and then return the first fill's full deposit amount minus total filled amount.
    const fillsOrderedByTotalFilledAmount = validFills.sort((fillA, fillB) => {
      const totalFilledA = getTotalFilledAmount(fillA);
      const totalFilledB = getTotalFilledAmount(fillB);

      return totalFilledB.gt(totalFilledA) ? 1 : totalFilledB.lt(totalFilledA) ? -1 : 0;
    });

    const lastFill = fillsOrderedByTotalFilledAmount[0];
    return {
      unfilledAmount: getFillOutputAmount(lastFill).sub(getTotalFilledAmount(lastFill)),
      fillCount: validFills.length,
      invalidFills,
    };
  }

  /**
   * Formulate a hash for a given deposit or fill
   * @param event The deposit or fill to formulate a hash for.
   * @returns The hash.
   * @note This hash is used to match deposits and fills together.
   * @note This hash takes the form of: `${depositId}-${originChainId}`.
   */
  public getDepositHash(event: { depositId: number; originChainId: number }): string {
    return `${event.depositId}-${event.originChainId}`;
  }

  /**
   * Find the block range that contains the deposit ID. This is a binary search that searches for the block range
   * that contains the deposit ID.
   * @param targetDepositId The target deposit ID to search for.
   * @param initLow The initial lower bound of the block range to search.
   * @param initHigh The initial upper bound of the block range to search.
   * @param maxSearches The maximum number of searches to perform. This is used to prevent infinite loops.
   * @returns The block range that contains the deposit ID.
   * @note  // We want to find the block range that satisfies these conditions:
   *        // - the low block has deposit count <= targetDepositId
   *        // - the high block has a deposit count > targetDepositId.
   *        // This way the caller can search for a FundsDeposited event between [low, high] that will always
   *        // contain the event emitted when deposit ID was incremented to targetDepositId + 1. This is the same transaction
   *        // where the deposit with deposit ID = targetDepositId was created.
   */
  public _getBlockRangeForDepositId(
    targetDepositId: number,
    initLow: number,
    initHigh: number,
    maxSearches: number
  ): Promise<{
    low: number;
    high: number;
  }> {
    return getBlockRangeForDepositId(targetDepositId, initLow, initHigh, maxSearches, this);
  }

  /**
   * Finds the deposit id at a specific block number.
   * @param blockTag The block number to search for the deposit ID at.
   * @returns The deposit ID.
   */
  public _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return getDepositIdAtBlock(this.spokePool as SpokePool, blockTag);
  }

  /**
   * Queries the SpokePool contract for a list of historical fills that match the given fill and deposit.
   * @param fill The fill to match.
   * @param deposit The deposit to match.
   * @param toBlock The block number to search up to.
   * @returns A list of fills that match the given fill and deposit.
   */
  public async queryHistoricalMatchingFills(
    fill: V2Fill,
    deposit: V2Deposit,
    toBlock: number
  ): Promise<V2FillWithBlock[]> {
    const searchConfig = {
      fromBlock: this.deploymentBlock,
      toBlock,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    return (await this.queryFillsInBlockRange(fill, searchConfig)).filter((_fill) =>
      validateFillForDeposit(_fill, deposit)
    );
  }

  /**
   * Queries the SpokePool contract for a list of fills that match the given fill.
   * @param fill The fill to match.
   * @param searchConfig The search configuration.
   * @returns A Promise that resolves to a list of fills that match the given fill.
   */
  public async queryFillsInBlockRange(
    matchingFill: V2Fill,
    searchConfig: EventSearchConfig
  ): Promise<V2FillWithBlock[]> {
    // Filtering on the fill's depositor address, the only indexed deposit field in the FilledRelay event,
    // should speed up this search a bit.
    // TODO: Once depositId is indexed in FilledRelay event, filter on that as well.
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.FilledRelay(
        undefined, // amount
        undefined, // totalFilledAmount
        undefined, // fillAmount
        undefined, // repaymentChainId
        matchingFill.originChainId, // originChainId
        undefined, // destinationChainId
        undefined, // relayerFeePct
        undefined, // realizedLpFeePct
        matchingFill.depositId, // depositId
        undefined, // destinationToken
        undefined, // relayer
        matchingFill.depositor, // depositor
        undefined, // recipient
        undefined, // message
        undefined // updatableRelayData
      ),
      searchConfig
    );
    const fills = query.map((event) => spreadEventWithBlockNumber(event) as V2FillWithBlock);
    return sortEventsAscending(fills.filter((_fill) => filledSameDeposit(_fill, matchingFill)));
  }

  /**
   * @notice Return maximum of fill deadline buffer at start and end of block range. This is a contract
   * immutable state variable so we can't query other events to find its updates.
   * @dev V3 deposits have a fill deadline which can be set to a maximum of fillDeadlineBuffer + deposit.block.timestamp.
   * Therefore, we cannot evaluate a block range for expired deposits if the spoke pool client doesn't return us
   * deposits whose block.timestamp is within fillDeadlineBuffer of the end block time. As a conservative check,
   * we verify that the time between the end block timestamp and the first timestamp queried by the
   * spoke pool client is greater than the maximum of the fill deadline buffers at the start and end of the block
   * range. We assume the fill deadline buffer wasn't changed more than once within a bundle.
   * @param startBlock start block
   * @param endBlock end block
   * @returns maximum of fill deadline buffer at start and end block
   */
  public async getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    const fillDeadlineBuffers: number[] = await Promise.all([
      this.spokePool.fillDeadlineBuffer({ blockTag: startBlock }),
      this.spokePool.fillDeadlineBuffer({ blockTag: endBlock }),
    ]);
    return Math.max(fillDeadlineBuffers[0], fillDeadlineBuffers[1]);
  }

  /**
   * Performs an update to refresh the state of this client. This will query the SpokePool contract for new events
   * and store them in memory. This method is the primary method for updating the state of this client.
   * @param eventsToQuery An optional list of events to query. If not provided, all events will be queried.
   * @returns A Promise that resolves to a SpokePoolUpdate object.
   */
  protected async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Find the earliest known depositId. This assumes no deposits were placed in the deployment block.
    let firstDepositId: number = this.firstDepositIdForSpokePool;
    if (firstDepositId === Number.MAX_SAFE_INTEGER) {
      firstDepositId = await this.spokePool.numberOfDeposits({ blockTag: this.deploymentBlock });
      if (isNaN(firstDepositId) || firstDepositId < 0) {
        throw new Error(`SpokePoolClient::update: Invalid first deposit id (${firstDepositId})`);
      }
    }

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.spokePool.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.log("warn", "Invalid update() searchConfig.", { searchConfig });
      return { success: false };
    }

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!this.queryableEventNames.includes(eventName)) {
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
        filter: this._queryableEventNames()[eventName],
        searchConfig: _searchConfig,
      };
    });

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: this.spokePool.address,
    });

    const timerStart = Date.now();
    const [numberOfDeposits, currentTime, oldestTime, ...events] = await Promise.all([
      this.spokePool.numberOfDeposits({ blockTag: searchConfig.toBlock }),
      this.spokePool.getCurrentTime({ blockTag: searchConfig.toBlock }),
      this.spokePool.getCurrentTime({ blockTag: Math.max(searchConfig.fromBlock, this.deploymentBlock) }),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    if (!BigNumber.isBigNumber(currentTime) || currentTime.lt(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`SpokePoolClient::update: ${errMsg}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    events.forEach((events: Event[]) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: currentTime.toNumber(), // uint32
      oldestTime: oldestTime.toNumber(),
      firstDepositId,
      latestDepositId: Math.max(numberOfDeposits - 1, 0),
      searchEndBlock: searchConfig.toBlock,
      events,
    };
  }

  _isEarlyDeposit(depositEvent: FundsDepositedEvent, currentTime: number): boolean {
    return depositEvent.args.quoteTimestamp > currentTime;
  }

  protected isV3DepositEvent(event: FundsDepositedEvent | V3FundsDepositedEvent): event is V3FundsDepositedEvent {
    return isDefined((event as V3FundsDepositedEvent).args.inputToken);
  }

  protected isV3FillEvent(event: FilledRelayEvent | FilledV3RelayEvent): event is FilledV3RelayEvent {
    return isDefined((event as FilledV3RelayEvent).args.inputToken);
  }

  /**
   * A wrapper over the `_update` method that handles errors and logs. This method additionally calls into the
   * HubPoolClient to update the state of this client with data from the HubPool contract.
   * @param eventsToQuery An optional list of events to query. If not provided, all events will be queried.
   * @returns A Promise that resolves to a SpokePoolUpdate object.
   * @note This method is the primary method for updating the state of this client externally.
   * @see _update
   */
  public async update(eventsToQuery = this.queryableEventNames): Promise<void> {
    if (this.hubPoolClient !== null && !this.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    const update = await this._update(eventsToQuery);
    if (!update.success) {
      // This failure only occurs if the RPC searchConfig is miscomputed, and has only been seen in the hardhat test
      // environment. Normal failures will throw instead. This is therefore an unfortunate workaround until we can
      // understand why we see this in test. @todo: Resolve.
      return;
    }
    const { events: queryResults, currentTime, oldestTime, searchEndBlock } = update;

    if (eventsToQuery.includes("TokensBridged")) {
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }
    }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited") || eventsToQuery.includes("V3FundsDeposited")) {
      // Filter out any early v2 deposits (quoteTimestamp > HubPoolClient.currentTime). Early deposits are no longer a
      // critical risk in v3, so don't worry about filtering those. This will reduce complexity in several places.
      const { earlyDeposits = [], v2DepositEvents = [] } = groupBy(
        [
          ...this.earlyDeposits,
          ...((queryResults[eventsToQuery.indexOf("FundsDeposited")] ?? []) as FundsDepositedEvent[]),
        ],
        (depositEvent) => (this._isEarlyDeposit(depositEvent, currentTime) ? "earlyDeposits" : "v2DepositEvents")
      );
      if (earlyDeposits.length > 0) {
        this.logger.debug({
          at: "SpokePoolClient#update",
          message: `Deferring ${earlyDeposits.length} early v2 deposit events.`,
          currentTime,
          deposits: earlyDeposits.map(({ args, transactionHash }) => ({ depositId: args.depositId, transactionHash })),
        });
      }
      this.earlyDeposits = earlyDeposits;

      const depositEvents = [
        ...v2DepositEvents,
        ...((queryResults[eventsToQuery.indexOf("V3FundsDeposited")] ?? []) as V3FundsDepositedEvent[]),
      ];
      if (depositEvents.length > 0) {
        this.log("debug", `Using ${depositEvents.length} newly queried deposit events for chain ${this.chainId}`, {
          earliestEvent: depositEvents[0].blockNumber,
        });
      }

      const dataForQuoteTime = await this.batchComputeRealizedLpFeePct(depositEvents);
      for (const [index, event] of Array.from(depositEvents.entries())) {
        const rawDeposit = spreadEventWithBlockNumber(event);
        let deposit: DepositWithBlock;

        // Derive and append the common properties that are not part of the onchain event.
        const { quoteBlock: quoteBlockNumber, realizedLpFeePct } = dataForQuoteTime[index];
        if (this.isV3DepositEvent(event)) {
          deposit = { ...(rawDeposit as V3DepositWithBlock), originChainId: this.chainId };
          deposit.realizedLpFeePct = undefined;
          deposit.quoteBlockNumber = quoteBlockNumber;
          if (deposit.outputToken === ZERO_ADDRESS) {
            deposit.outputToken = this.getDestinationTokenForDeposit(deposit);
          }
        } else {
          deposit = { ...(rawDeposit as V2DepositWithBlock) };
          deposit.realizedLpFeePct = realizedLpFeePct;
          deposit.quoteBlockNumber = quoteBlockNumber;
          deposit.destinationToken = this.getDestinationTokenForDeposit(deposit);
        }

        if (this.depositHashes[this.getDepositHash(deposit)] !== undefined) {
          continue;
        }
        assign(this.depositHashes, [this.getDepositHash(deposit)], deposit);

        if (deposit.depositId < this.earliestDepositIdQueried) {
          this.earliestDepositIdQueried = deposit.depositId;
        }
        if (deposit.depositId > this.latestDepositIdQueried) {
          this.latestDepositIdQueried = deposit.depositId;
        }
      }
    }

    // TODO: When validating fills with deposits for the purposes of UBA flows, do we need to consider
    // speed ups as well? For example, do we need to also consider that the speed up is before the fill
    // timestamp to be applied for the fill? My brain hurts.
    // Update deposits with speed up requests from depositor.
    if (eventsToQuery.includes("RequestedSpeedUpDeposit") || eventsToQuery.includes("RequestedSpeedUpV3Deposit")) {
      const speedUpEvents = [
        ...(queryResults[eventsToQuery.indexOf("RequestedSpeedUpDeposit")] ?? []),
        ...(queryResults[eventsToQuery.indexOf("RequestedSpeedUpV3Deposit")] ?? []),
      ];

      for (const event of speedUpEvents) {
        const speedUp: SpeedUp = { ...spreadEvent(event.args), originChainId: this.chainId };
        assign(this.speedUps, [speedUp.depositor, speedUp.depositId], [speedUp]);

        // Find deposit hash matching this speed up event and update the deposit data associated with the hash,
        // if the hash+data exists.
        const depositHash = this.getDepositHash(speedUp);

        // We can assume all deposits in this lookback window are loaded in-memory already so if the depositHash
        // is not mapped to a deposit, then we can throw away the speedup as it can't be applied to anything.
        const depositDataAssociatedWithSpeedUp = this.depositHashes[depositHash];
        if (isDefined(depositDataAssociatedWithSpeedUp)) {
          this.depositHashes[depositHash] = this.appendMaxSpeedUpSignatureToDeposit(depositDataAssociatedWithSpeedUp);
        }
      }
    }

    if (eventsToQuery.includes("RequestedV3SlowFill")) {
      const slowFillRequests = queryResults[eventsToQuery.indexOf("RequestedV3SlowFill")];
      for (const event of slowFillRequests) {
        const slowFillRequest: SlowFillRequestWithBlock = {
          ...(spreadEventWithBlockNumber(event) as SlowFillRequestWithBlock),
          destinationChainId: this.chainId,
        };
        const relayDataHash = getRelayDataHash(slowFillRequest, this.chainId);
        if (this.slowFillRequests[relayDataHash] !== undefined) {
          continue;
        }
        this.slowFillRequests[relayDataHash] = slowFillRequest;
      }
    }

    if (eventsToQuery.includes("FilledRelay") || eventsToQuery.includes("FilledV3Relay")) {
      const fillEvents = [
        ...((queryResults[eventsToQuery.indexOf("FilledRelay")] ?? []) as FilledRelayEvent[]),
        ...((queryResults[eventsToQuery.indexOf("FilledV3Relay")] ?? []) as FilledV3RelayEvent[]),
      ];

      if (fillEvents.length > 0) {
        this.log("debug", `Using ${fillEvents.length} newly queried fill events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      }

      // @note The type assertions here suppress errors that might arise due to incomplete types. For now, verify via
      // test that the types are complete. A broader change in strategy for safely unpacking events will be introduced.
      for (const event of fillEvents) {
        const fill = this.isV3FillEvent(event)
          ? { ...(spreadEventWithBlockNumber(event) as V3FillWithBlock), destinationChainId: this.chainId }
          : { ...(spreadEventWithBlockNumber(event) as V2FillWithBlock) };

        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
      }
    }

    if (eventsToQuery.includes("EnabledDepositRoute")) {
      const enableDepositsEvents = queryResults[eventsToQuery.indexOf("EnabledDepositRoute")];

      for (const event of enableDepositsEvents) {
        const enableDeposit = spreadEvent(event.args);
        assign(
          this.depositRoutes,
          [enableDeposit.originToken, enableDeposit.destinationChainId],
          enableDeposit.enabled
        );
      }
    }

    if (eventsToQuery.includes("RelayedRootBundle")) {
      const relayedRootBundleEvents = queryResults[eventsToQuery.indexOf("RelayedRootBundle")];
      for (const event of relayedRootBundleEvents) {
        this.rootBundleRelays.push(spreadEventWithBlockNumber(event) as RootBundleRelayWithBlock);
      }
    }

    if (eventsToQuery.includes("ExecutedRelayerRefundRoot")) {
      const refundEvents = queryResults[eventsToQuery.indexOf("ExecutedRelayerRefundRoot")];
      for (const event of refundEvents) {
        const executedRefund = spreadEventWithBlockNumber(event) as RelayerRefundExecutionWithBlock;
        executedRefund.l2TokenAddress = SpokePoolClient.getExecutedRefundLeafL2Token(
          executedRefund.chainId,
          executedRefund.l2TokenAddress
        );
        this.relayerRefundExecutions.push(executedRefund);
      }
    }

    // Next iteration should start off from where this one ended.
    this.currentTime = currentTime;
    if (this.oldestTime === 0) this.oldestTime = oldestTime; // Set oldest time only after the first update.
    this.firstDepositIdForSpokePool = update.firstDepositId;
    this.latestBlockSearched = searchEndBlock;
    this.lastDepositIdForSpokePool = update.latestDepositId;
    this.firstBlockToSearch = searchEndBlock + 1;
    this.eventSearchConfig.toBlock = undefined; // Caller can re-set on subsequent updates if necessary
    this.isUpdated = true;
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, {
      nextFirstBlockToSearch: this.firstBlockToSearch,
    });
  }

  /**
   * Retrieves the l2TokenAddress for a given executed refund leaf.
   * @param chainId The chain ID of the executed refund leaf.
   * @param eventL2Token The l2TokenAddress of the executed refund leaf.
   * @returns The l2TokenAddress of the executed refund leaf.
   */
  public static getExecutedRefundLeafL2Token(chainId: number, eventL2Token: string): string {
    // If execution of WETH refund leaf occurred on an OVM spoke pool, then we'll convert its l2Token from the native
    // token address to the wrapped token address. This is because the OVM_SpokePool modifies the l2TokenAddress prop
    // in _bridgeTokensToHubPool before emitting the ExecutedRelayerRefundLeaf event.
    // Here is the contract code referenced:
    // - https://github.com/across-protocol/contracts-v2/blob/954528a4620863d1c868e54a370fd8556d5ed05c/contracts/Ovm_SpokePool.sol#L142
    if (
      (chainId === 10 || chainId === 8453) &&
      eventL2Token.toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000"
    ) {
      return "0x4200000000000000000000000000000000000006";
    } else if (chainId === 288 && eventL2Token.toLowerCase() === "0x4200000000000000000000000000000000000006") {
      return "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";
    } else {
      return eventL2Token;
    }
  }

  /**
   * Computes the realized LP fee percentage for a given deposit.
   * @param depositEvent The deposit event to compute the realized LP fee percentage for.
   * @returns The realized LP fee percentage.
   */
  protected async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent): Promise<RealizedLpFee> {
    const [lpFee] = await this.batchComputeRealizedLpFeePct([depositEvent]);
    return lpFee;
  }

  /**
   * Computes the realized LP fee percentage for a batch of deposits.
   * @dev Computing in batch opens up for efficiencies, e.g. in quoteTimestamp -> blockNumber resolution.
   * @param depositEvents The array of deposit events to compute the realized LP fee percentage for.
   * @returns The array of realized LP fee percentages and associated HubPool block numbers.
   */
  protected async batchComputeRealizedLpFeePct(
    depositEvents: (FundsDepositedEvent | V3FundsDepositedEvent)[]
  ): Promise<RealizedLpFee[]> {
    // If no hub pool client, we're using this for testing. Set quote block very high so that if it's ever
    // used to look up a configuration for a block, it will always match with the latest configuration.
    if (this.hubPoolClient === null) {
      const realizedLpFeePct = bnZero;
      const quoteBlock = MAX_BIG_INT.toNumber();
      return depositEvents.map(() => {
        return { realizedLpFeePct, quoteBlock };
      });
    }

    const deposits = depositEvents.map((event) => {
      let inputToken: string, inputAmount: BigNumber;

      // For v3 deposits, leave payment chain ID undefined so we don't compute lp fee since we don't have the
      // payment chain ID until we match this deposit with a fill.
      let _paymentChainId: number | undefined;
      if (this.isV3DepositEvent(event)) {
        ({ inputToken, inputAmount } = event.args);
      } else {
        // Coerce v2 deposit objects into V3 format.
        ({ originToken: inputToken, amount: inputAmount } = event.args);
        _paymentChainId = Number(event.args.destinationChainId);
      }
      return {
        inputToken,
        inputAmount,
        originChainId: this.chainId,
        paymentChainId: _paymentChainId,
        quoteTimestamp: event.args.quoteTimestamp,
      };
    });

    return deposits.length > 0 ? await this.hubPoolClient.batchComputeRealizedLpFeePct(deposits) : [];
  }

  /**
   * Retrieves the destination token for a given deposit.
   * @param deposit The deposit to retrieve the destination token for.
   * @returns The destination token.
   */
  protected getDestinationTokenForDeposit(deposit: DepositWithBlock): string {
    // If there is no rate model client return address(0).
    if (!this.hubPoolClient) {
      return ZERO_ADDRESS;
    }

    return this.hubPoolClient.getL2TokenForDeposit(deposit);
  }

  /**
   * Performs a log for a specific level, message and data.
   * @param level The log level.
   * @param message The log message.
   * @param data Optional data to log.
   */
  protected log(level: DefaultLogLevels, message: string, data?: AnyObject) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }

  /**
   * Retrieves the current time from the SpokePool contract.
   * @returns The current time, which will be 0 if there has been no update() yet.
   */
  public getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Retrieves the oldest time searched on the SpokePool contract.
   * @returns The oldest time searched, which will be 0 if there has been no update() yet.
   */
  public getOldestTime(): number {
    return this.oldestTime;
  }

  /**
   * Finds a deposit for a given deposit ID, destination chain ID and depositor address. This method will search for
   * the deposit in the SpokePool contract and return it if found. If the deposit is not found, this method will
   * perform a binary search to find the block range that contains the deposit ID and then perform an eth_getLogs
   * call to find the deposit.
   * @param depositId The deposit ID to find.
   * @param destinationChainId The destination chain ID to find.
   * @param depositor The depositor address to find.
   * @returns The deposit if found.
   * @note This method is used to find deposits that are outside of the search range of this client.
   */
  async findDeposit(depositId: number, destinationChainId: number, depositor: string): Promise<V2DepositWithBlock> {
    // Binary search for block. This way we can get the blocks before and after the deposit with
    // deposit ID = fill.depositId and use those blocks to optimize the search for that deposit.
    // Stop searches after a maximum # of searches to limit number of eth_call requests. Make an
    // eth_getLogs call on the remaining block range (i.e. the [low, high] remaining from the binary
    // search) to find the target deposit ID.
    //
    // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
    // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
    const searchBounds = await this._getBlockRangeForDepositId(
      depositId,
      this.deploymentBlock,
      this.latestBlockSearched,
      7
    );

    const tStart = Date.now();
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.FundsDeposited(
        null,
        null,
        destinationChainId,
        null,
        depositId,
        null,
        null,
        null,
        depositor,
        null
      ),
      {
        fromBlock: searchBounds.low,
        toBlock: searchBounds.high,
        maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
      }
    );
    const tStop = Date.now();

    const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === depositId);
    if (event === undefined) {
      const srcChain = getNetworkName(this.chainId);
      const dstChain = getNetworkName(destinationChainId);
      throw new Error(
        `Could not find deposit ${depositId} for ${dstChain} fill` +
          ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
      );
    }
    const partialDeposit = spreadEventWithBlockNumber(event) as V2DepositWithBlock;
    const { realizedLpFeePct, quoteBlock: quoteBlockNumber } = (await this.batchComputeRealizedLpFeePct([event]))[0]; // Append the realizedLpFeePct.

    // Append destination token and realized lp fee to deposit.
    const deposit: V2DepositWithBlock = {
      ...partialDeposit,
      realizedLpFeePct,
      destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
      quoteBlockNumber,
    };

    this.logger.debug({
      at: "SpokePoolClient#findDeposit",
      message: "Located deposit outside of SpokePoolClient's search range",
      deposit,
      elapsedMs: tStop - tStart,
    });

    return deposit;
  }

  async findDepositV3(depositId: number, destinationChainId: number, depositor: string): Promise<V3DepositWithBlock> {
    // Binary search for event search bounds. This way we can get the blocks before and after the deposit with
    // deposit ID = fill.depositId and use those blocks to optimize the search for that deposit.
    // Stop searches after a maximum # of searches to limit number of eth_call requests. Make an
    // eth_getLogs call on the remaining block range (i.e. the [low, high] remaining from the binary
    // search) to find the target deposit ID.
    //
    // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
    // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
    const searchBounds = await this._getBlockRangeForDepositId(
      depositId,
      this.deploymentBlock,
      this.latestBlockSearched,
      7
    );

    const tStart = Date.now();
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.V3FundsDeposited(
        null,
        null,
        null,
        null,
        destinationChainId,
        depositId,
        null,
        null,
        null,
        depositor,
        null,
        null,
        null
      ),
      {
        fromBlock: searchBounds.low,
        toBlock: searchBounds.high,
        maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
      }
    );
    const tStop = Date.now();

    const event = (query as V3FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === depositId);
    if (event === undefined) {
      const srcChain = getNetworkName(this.chainId);
      const dstChain = getNetworkName(destinationChainId);
      throw new Error(
        `Could not find deposit ${depositId} for ${dstChain} fill` +
          ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
      );
    }
    const partialDeposit = spreadEventWithBlockNumber(event) as V3DepositWithBlock;
    const { quoteBlock: quoteBlockNumber } = (await this.batchComputeRealizedLpFeePct([event]))[0]; // Append the realizedLpFeePct.

    // Append destination token and realized lp fee to deposit.
    const deposit: V3DepositWithBlock = {
      ...partialDeposit,
      originChainId: this.chainId,
      quoteBlockNumber,
      outputToken:
        partialDeposit.outputToken === ZERO_ADDRESS
          ? this.getDestinationTokenForDeposit({ ...partialDeposit, originChainId: this.chainId })
          : partialDeposit.outputToken,
    };

    this.logger.debug({
      at: "SpokePoolClient#findDepositV3",
      message: "Located V3 deposit outside of SpokePoolClient's search range",
      deposit,
      elapsedMs: tStop - tStart,
    });

    return deposit;
  }
}
