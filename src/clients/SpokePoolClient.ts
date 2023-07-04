import { groupBy } from "lodash";
import {
  spreadEvent,
  assign,
  EventSearchConfig,
  sortEventsAscendingInPlace,
  DefaultLogLevels,
  MakeOptional,
  sortEventsAscending,
  filledSameDeposit,
  validateFillForDeposit,
  AnyObject,
} from "../utils";
import { toBN, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";
import winston from "winston";

import { Contract, BigNumber, Event, EventFilter } from "ethers";

import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  RelayerRefundExecutionWithBlock,
  RootBundleRelayWithBlock,
  SpeedUp,
  TokensBridged,
  FundsDepositedEvent,
} from "../interfaces";
import { HubPoolClient } from ".";
import { ZERO_ADDRESS } from "../constants";

type _SpokePoolUpdate = {
  success: boolean;
  currentTime: number;
  firstDepositId: number;
  latestBlockNumber: number;
  latestDepositId: number;
  events: Event[][];
  searchEndBlock: number;
};
export type SpokePoolUpdate = { success: false } | _SpokePoolUpdate;

/**
 * SpokePoolClient is a client for the SpokePool contract. It is responsible for querying the SpokePool contract
 * for events and storing them in memory. It also provides some convenience methods for querying the stored events.
 */
export class SpokePoolClient {
  protected currentTime = 0;
  protected depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  protected depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  protected speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
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
  public isUpdated = false;
  public firstBlockToSearch: number;
  public latestBlockNumber = 0;
  public deposits: { [DestinationChainId: number]: DepositWithBlock[] } = {};
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};
  public refundRequests: RefundRequestWithBlock[] = [];

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
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.queryableEventNames = Object.keys(this._queryableEventNames());
  }

  public _queryableEventNames(): { [eventName: string]: EventFilter } {
    return {
      FundsDeposited: this.spokePool.filters.FundsDeposited(),
      RequestedSpeedUpDeposit: this.spokePool.filters.RequestedSpeedUpDeposit(),
      FilledRelay: this.spokePool.filters.FilledRelay(),
      RefundRequested: this.spokePool.filters.RefundRequested(),
      EnabledDepositRoute: this.spokePool.filters.EnabledDepositRoute(),
      TokensBridged: this.spokePool.filters.TokensBridged(),
      RelayedRootBundle: this.spokePool.filters.RelayedRootBundle(),
      ExecutedRelayerRefundRoot: this.spokePool.filters.ExecutedRelayerRefundRoot(),
    };
  }

  /**
   * Retrieves a list of deposits from the SpokePool contract destined for the given destination chain ID.
   * @param destinationChainId The destination chain ID.
   * @returns A list of deposits.
   */
  public getDepositsForDestinationChain(destinationChainId: number): DepositWithBlock[] {
    return this.deposits[destinationChainId] || [];
  }

  /**
   * Retrieves a list of deposits from the SpokePool contract that are associated with this spoke pool.
   * @returns A list of deposits.
   * @note This method returns all deposits, regardless of destination chain ID in sorted order.
   */
  public getDeposits(): DepositWithBlock[] {
    return sortEventsAscendingInPlace(Object.values(this.deposits).flat());
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
   * Retrieves a list of refund requests from the SpokePool contract that are within an optional block range.
   * @param fromBlock The starting block number. If not provided, requests will not be filtered by any bounds.
   * @param toBlock The ending block number. If not provided, requests will not be filtered by any bounds.
   * @returns A list of refund requests.
   */
  public getRefundRequests(fromBlock?: number, toBlock?: number): RefundRequestWithBlock[] {
    return fromBlock === undefined || toBlock === undefined || isNaN(fromBlock) || isNaN(toBlock)
      ? this.refundRequests
      : this.refundRequests.filter((request) => request.blockNumber >= fromBlock && request.blockNumber <= toBlock);
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
          executedTokenRefunds[relayer] = BigNumber.from(0);
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
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId]?.reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // We assume that the depositor authorises SpeedUps in isolation of each other, which keeps the relayer
    // logic simple: find the SpeedUp with the highest relayerFeePct, and use all of its fields
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) {
      return deposit;
    }

    // Return deposit with updated params from the speedup with the highest updated relayer fee pct.
    return {
      ...deposit,
      speedUpSignature: maxSpeedUp.depositorSignature,
      newRelayerFeePct: maxSpeedUp.newRelayerFeePct,
      updatedRecipient: maxSpeedUp.updatedRecipient,
      updatedMessage: maxSpeedUp.updatedMessage,
    };
  }

  /**
   * Find a corresponding deposit for a given fill.
   * @param fill The fill to find a corresponding deposit for.
   * @returns The corresponding deposit if found, undefined otherwise.
   */
  public getDepositForFill(fill: Fill): DepositWithBlock | undefined {
    const depositWithMatchingDepositId = this.depositHashes[this.getDepositHash(fill)];
    return validateFillForDeposit(fill, depositWithMatchingDepositId) ? depositWithMatchingDepositId : undefined;
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
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0, invalidFills: [] };
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
      });
    }

    // If all fills are invalid we can consider this unfilled.
    if (validFills.length === 0) {
      return { unfilledAmount: toBN(deposit.amount), fillCount: 0, invalidFills };
    }

    // Order fills by totalFilledAmount and then return the first fill's full deposit amount minus total filled amount.
    const fillsOrderedByTotalFilledAmount = validFills.sort((fillA, fillB) =>
      fillB.totalFilledAmount.gt(fillA.totalFilledAmount)
        ? 1
        : fillB.totalFilledAmount.lt(fillA.totalFilledAmount)
        ? -1
        : 0
    );

    const lastFill = fillsOrderedByTotalFilledAmount[0];
    return {
      unfilledAmount: toBN(lastFill.amount.sub(lastFill.totalFilledAmount)),
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
  public getDepositHash(event: Deposit | Fill): string {
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
  public async _getBlockRangeForDepositId(
    targetDepositId: number,
    initLow: number,
    initHigh: number,
    maxSearches: number
  ): Promise<{
    low: number;
    high: number;
  }> {
    if (initLow > initHigh) {
      throw new Error("Binary search failed because low > high");
    }
    if (maxSearches <= 0) {
      throw new Error("maxSearches must be > 0");
    }

    let low = initLow;
    let high = initHigh;
    let i = 0;
    do {
      const mid = Math.floor((high + low) / 2);
      const searchedDepositId = await this._getDepositIdAtBlock(mid);
      if (!Number.isInteger(searchedDepositId)) {
        throw new Error("Invalid deposit count");
      }

      // Caller can set maxSearches to minimize number of binary searches and eth_call requests.
      if (i++ >= maxSearches) {
        return { low, high };
      }

      // Since the deposit ID can jump by more than 1 in a block (e.g. if multiple deposits are sent
      // in the same block), we need to search inclusively on on the low and high, instead of the
      // traditional binary search where we set high to mid - 1 and low to mid + 1. This makes sure we
      // don't accidentally skip over mid which contains multiple deposit ID's.
      if (targetDepositId > searchedDepositId) {
        low = mid;
      } else if (targetDepositId < searchedDepositId) {
        high = mid;
      } else {
        return { low, high };
      }
    } while (low <= high);
    throw new Error("Failed to find deposit ID");
  }

  /**
   * Finds the deposit id at a specific block number.
   * @param blockTag The block number to search for the deposit ID at.
   * @returns The deposit ID.
   */
  public async _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return await this.spokePool.numberOfDeposits({ blockTag });
  }

  /**
   * Queries the SpokePool contract for a list of historical fills that match the given fill and deposit.
   * @param fill The fill to match.
   * @param deposit The deposit to match.
   * @param toBlock The block number to search up to.
   * @returns A list of fills that match the given fill and deposit.
   */
  public async queryHistoricalMatchingFills(fill: Fill, deposit: Deposit, toBlock: number): Promise<FillWithBlock[]> {
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
  public async queryFillsInBlockRange(matchingFill: Fill, searchConfig: EventSearchConfig): Promise<FillWithBlock[]> {
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
    const fills = query.map((event) => spreadEventWithBlockNumber(event) as FillWithBlock);
    return sortEventsAscending(fills.filter((_fill) => filledSameDeposit(_fill, matchingFill)));
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

    const latestBlockNumber = await this.spokePool.provider.getBlockNumber();
    if (isNaN(latestBlockNumber) || latestBlockNumber < this.latestBlockNumber) {
      throw new Error(`SpokePoolClient::update: latestBlockNumber ${latestBlockNumber} < ${this.latestBlockNumber}`);
    }

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
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
    const [numberOfDeposits, currentTime, ...events] = await Promise.all([
      this.spokePool.numberOfDeposits({ blockTag: searchConfig.toBlock }),
      this.spokePool.getCurrentTime({ blockTag: searchConfig.toBlock }),
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
      firstDepositId,
      latestBlockNumber,
      latestDepositId: Math.max(numberOfDeposits - 1, 0),
      searchEndBlock: searchConfig.toBlock,
      events,
    };
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
    const { events: queryResults, currentTime } = update;

    if (eventsToQuery.includes("TokensBridged")) {
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }
    }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (eventsToQuery.includes("FundsDeposited")) {
      const allDeposits = [
        ...(queryResults[eventsToQuery.indexOf("FundsDeposited")] as FundsDepositedEvent[]),
        ...this.earlyDeposits,
      ];
      const { earlyDeposits = [], depositEvents = [] } = groupBy(allDeposits, (depositEvent) => {
        if (depositEvent.args.quoteTimestamp > currentTime) {
          const { args, transactionHash } = depositEvent;
          this.logger.debug({
            at: "SpokePoolClient#update",
            message: "Deferring early deposit event.",
            currentTime,
            deposit: { args, transactionHash },
          });
          return "earlyDeposits";
        } else {
          return "depositEvents";
        }
      });
      this.earlyDeposits = earlyDeposits;

      if (depositEvents.length > 0) {
        this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
          numDeposits: depositEvents.length,
        });
      }

      const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.all(
        depositEvents.map(async (event) => this.computeRealizedLpFeePct(event))
      );

      // Now add any newly fetched events from RPC.
      if (depositEvents.length > 0) {
        this.log("debug", `Using ${depositEvents.length} newly queried deposit events for chain ${this.chainId}`, {
          earliestEvent: depositEvents[0].blockNumber,
        });
      }
      for (const [index, event] of Array.from(depositEvents.entries())) {
        // Append the realizedLpFeePct.
        const partialDeposit = spreadEventWithBlockNumber(event) as DepositWithBlock;

        // Append destination token and realized lp fee to deposit.
        const deposit: DepositWithBlock = {
          ...partialDeposit,
          realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct,
          destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
          quoteBlockNumber: dataForQuoteTime[index].quoteBlock,
        };

        assign(this.depositHashes, [this.getDepositHash(deposit)], deposit);
        assign(this.deposits, [deposit.destinationChainId], [deposit]);

        if (deposit.depositId < this.earliestDepositIdQueried) {
          this.earliestDepositIdQueried = deposit.depositId;
        }
        if (deposit.depositId > this.latestDepositIdQueried) {
          this.latestDepositIdQueried = deposit.depositId;
        }
      }
    }

    // Update deposits with speed up requests from depositor.
    if (eventsToQuery.includes("RequestedSpeedUpDeposit")) {
      const speedUpEvents = queryResults[eventsToQuery.indexOf("RequestedSpeedUpDeposit")];

      for (const event of speedUpEvents) {
        const speedUp: SpeedUp = { ...spreadEvent(event.args), originChainId: this.chainId };
        assign(this.speedUps, [speedUp.depositor, speedUp.depositId], [speedUp]);
      }

      // Traverse all deposit events and update them with associated speedups, If they exist.
      for (const [, deposits] of Object.entries(this.deposits)) {
        for (const [index, deposit] of Array.from(deposits.entries())) {
          deposits[index] = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        }
      }
    }

    if (eventsToQuery.includes("FilledRelay")) {
      const fillEvents = queryResults[eventsToQuery.indexOf("FilledRelay")];

      if (fillEvents.length > 0) {
        this.log("debug", `Using ${fillEvents.length} newly queried fill events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      }
      for (const event of fillEvents) {
        const fill = spreadEventWithBlockNumber(event) as FillWithBlock;
        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
      }
    }

    // @note: In Across 2.5, callers will simultaneously request [FundsDeposited, FilledRelay, RefundsRequested].
    // The list of events is always pre-sorted, so rather than splitting them out individually, it might make sense to
    // evaluate them as a single group, to avoid having to re-merge and sequence again afterwards.
    if (eventsToQuery.includes("RefundRequested")) {
      const refundRequests = queryResults[eventsToQuery.indexOf("RefundRequested")];

      if (refundRequests.length > 0) {
        this.log("debug", `Found ${refundRequests.length} new relayer refund requests on chain ${this.chainId}`, {
          earliestEvent: refundRequests[0].blockNumber,
        });
      }
      for (const refundRequest of refundRequests) {
        this.refundRequests.push(spreadEventWithBlockNumber(refundRequest) as RefundRequestWithBlock);
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
      const executedRelayerRefundRootEvents = queryResults[eventsToQuery.indexOf("ExecutedRelayerRefundRoot")];
      for (const event of executedRelayerRefundRootEvents) {
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
    this.firstDepositIdForSpokePool = update.firstDepositId;
    this.latestBlockNumber = update.latestBlockNumber;
    this.lastDepositIdForSpokePool = update.latestDepositId;
    this.firstBlockToSearch = update.searchEndBlock + 1;
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
    if (chainId === 10 && eventL2Token.toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000") {
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
  protected async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent) {
    if (this.hubPoolClient === null) {
      return { realizedLpFeePct: toBN(0), quoteBlock: 0 };
    }

    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      destinationChainId: Number(depositEvent.args.destinationChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
    };

    const l1Token = this.hubPoolClient.getL1TokenForDeposit(deposit);
    return this.hubPoolClient.computeRealizedLpFeePct(deposit, l1Token);
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
    return this.hubPoolClient.getDestinationTokenForDeposit(deposit);
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
   * @returns The current time.
   */
  public getCurrentTime(): number {
    return this.currentTime;
  }
}
