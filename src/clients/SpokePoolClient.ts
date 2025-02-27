import assert from "assert";
import { Contract, EventFilter } from "ethers";
import winston from "winston";
import {
  AnyObject,
  BigNumber,
  bnZero,
  bnUint32Max,
  DefaultLogLevels,
  EventSearchConfig,
  MAX_BIG_INT,
  MakeOptional,
  assign,
  getRelayEventKey,
  isDefined,
  toBN,
  bnOne,
  getMessageHash,
  isUnsafeDepositId,
  isSlowFill,
  EvmAddress,
  Address,
} from "../utils";
import {
  duplicateEvent,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
  spreadEvent,
  spreadEventWithBlockNumber,
} from "../utils/EventUtils";
import { validateFillForDeposit } from "../utils/FlowUtils";
import { ZERO_ADDRESS } from "../constants";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillStatus,
  FillWithBlock,
  Log,
  RelayData,
  RelayerRefundExecutionWithBlock,
  RootBundleRelayWithBlock,
  SlowFillRequestWithBlock,
  SpeedUpWithBlock,
  TokensBridged,
} from "../interfaces";
import { SpokePool } from "../typechain";
import { getNetworkName } from "../utils/NetworkUtils";
import { getBlockRangeForDepositId, getDepositIdAtBlock, relayFillStatus } from "../utils/SpokeUtils";
import { BaseAbstractClient, isUpdateFailureReason, UpdateFailureReason } from "./BaseAbstractClient";
import { HubPoolClient } from "./HubPoolClient";
import { AcrossConfigStoreClient } from "./AcrossConfigStoreClient";
import { getRepaymentChainId, forceDestinationRepayment } from "./BundleDataClient/utils/FillUtils";

type SpokePoolUpdateSuccess = {
  success: true;
  currentTime: number;
  firstDepositId: BigNumber;
  latestDepositId: BigNumber;
  events: Log[][];
  searchEndBlock: number;
};
type SpokePoolUpdateFailure = {
  success: false;
  reason: UpdateFailureReason;
};
export type SpokePoolUpdate = SpokePoolUpdateSuccess | SpokePoolUpdateFailure;

/**
 * SpokePoolClient is a client for the SpokePool contract. It is responsible for querying the SpokePool contract
 * for events and storing them in memory. It also provides some convenience methods for querying the stored events.
 */
export class SpokePoolClient extends BaseAbstractClient {
  protected currentTime = 0;
  protected depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  protected duplicateDepositHashes: { [depositHash: string]: DepositWithBlock[] } = {};
  protected depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  protected speedUps: { [depositorAddress: string]: { [depositId: string]: SpeedUpWithBlock[] } } = {};
  protected slowFillRequests: { [relayDataHash: string]: SlowFillRequestWithBlock } = {};
  protected depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  protected tokensBridged: TokensBridged[] = [];
  protected rootBundleRelays: RootBundleRelayWithBlock[] = [];
  protected relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  protected queryableEventNames: string[] = [];
  protected configStoreClient: AcrossConfigStoreClient | undefined;
  public earliestDepositIdQueried = MAX_BIG_INT;
  public latestDepositIdQueried = bnZero;
  public firstDepositIdForSpokePool = MAX_BIG_INT;
  public lastDepositIdForSpokePool = MAX_BIG_INT;
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
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super(eventSearchConfig);
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.latestBlockSearched = 0;
    this.queryableEventNames = Object.keys(this._queryableEventNames());
    this.configStoreClient = hubPoolClient?.configStoreClient;
  }

  public _queryableEventNames(): { [eventName: string]: EventFilter } {
    const knownEventNames = [
      "EnabledDepositRoute",
      "TokensBridged",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
      "V3FundsDeposited",
      "FundsDeposited",
      "RequestedSpeedUpV3Deposit",
      "RequestedSpeedUpDeposit",
      "RequestedV3SlowFill",
      "RequestedSlowFill",
      "FilledV3Relay",
      "FilledRelay",
    ];
    return Object.fromEntries(
      this.spokePool.interface.fragments
        .filter(({ name, type }) => type === "event" && knownEventNames.includes(name))
        .map(({ name }) => [name, this.spokePool.filters[name]()])
    );
  }

  /**
   * Retrieves a list of unique deposits from the SpokePool contract destined for the given destination chain ID.
   * @param destinationChainId The destination chain ID.
   * @returns A list of deposits.
   */
  public getDepositsForDestinationChain(destinationChainId: number): DepositWithBlock[] {
    return Object.values(this.depositHashes).filter((deposit) => deposit.destinationChainId === destinationChainId);
  }

  /**
   * Retrieves a list of duplicate deposits matching the given deposit's deposit hash.
   * @notice A duplicate is considered any deposit sent after the original deposit with the same deposit hash.
   * @param deposit The deposit to find duplicates for.
   * @returns A list of duplicate deposits. Does NOT include the original deposit
   * unless the original deposit is a duplicate.
   */
  private _getDuplicateDeposits(deposit: DepositWithBlock): DepositWithBlock[] {
    const depositHash = getRelayEventKey(deposit);
    return this.duplicateDepositHashes[depositHash] ?? [];
  }

  /**
   * Returns a list of all deposits including any duplicate ones. Designed only to be used in use cases where
   * all deposits are required, regardless of duplicates. For example, the Dataworker can use this to refund
   * expired deposits including for duplicates.
   * @param destinationChainId
   * @returns A list of deposits
   */
  public getDepositsForDestinationChainWithDuplicates(destinationChainId: number): DepositWithBlock[] {
    const deposits = this.getDepositsForDestinationChain(destinationChainId);
    const duplicateDeposits = deposits.reduce((acc, deposit) => {
      const duplicates = this._getDuplicateDeposits(deposit);
      return acc.concat(duplicates);
    }, [] as DepositWithBlock[]);
    return sortEventsAscendingInPlace(deposits.concat(duplicateDeposits.flat()));
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
  public getFillsForRelayer(relayer: Address): FillWithBlock[] {
    return this.getFills().filter((fill) => fill.relayer.eq(relayer));
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
   * Appends a speed up signature to a specific deposit.
   * @param deposit The deposit to append the speed up signature to.
   * @returns A new deposit instance with the speed up signature appended to the deposit.
   */
  public appendMaxSpeedUpSignatureToDeposit(deposit: DepositWithBlock): DepositWithBlock {
    const { depositId, depositor } = deposit;

    // Note: we know depositor cannot be more than 20 bytes since this is guaranteed by contracts.
    const speedups = this.speedUps[depositor.toString()]?.[depositId.toString()];

    if (!isDefined(speedups) || speedups.length === 0) {
      return deposit;
    }

    const maxSpeedUp = speedups.reduce((prev, current) =>
      prev.updatedOutputAmount.lt(current.updatedOutputAmount) ? prev : current
    );

    // We assume that the depositor authorises SpeedUps in isolation of each other, which keeps the relayer
    // logic simple: find the SpeedUp with the lowest updatedOutputAmount, and use all of its fields.
    if (maxSpeedUp.updatedOutputAmount.gte(deposit.outputAmount)) {
      return deposit;
    }

    // Return deposit with updated params from the speedup with the lowest updated output amount.
    const updatedDeposit = {
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
  public getDeposit(depositId: BigNumber): DepositWithBlock | undefined {
    return Object.values(this.depositHashes).find(({ depositId: _depositId }) => _depositId.eq(depositId));
  }

  /**
   * Retrieves a list of slow fill requests from the SpokePool contract.
   * @returns A list of slow fill requests.
   */
  public getSlowFillRequests(): SlowFillRequestWithBlock[] {
    return sortEventsAscendingInPlace(Object.values(this.slowFillRequests));
  }

  /**
   * Find a SlowFillRequested event based on its deposit RelayData.
   * @param relayData RelayData field for the SlowFill request.
   * @returns The corresponding SlowFillRequest event if found, otherwise undefined.
   */
  public getSlowFillRequest(relayData: RelayData): SlowFillRequestWithBlock | undefined {
    const messageHash = getMessageHash(relayData.message);
    const hash = getRelayEventKey({ ...relayData, messageHash, destinationChainId: this.chainId });
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
   * Retrieves speed up requests grouped by depositor and depositId.
   * @returns A mapping of depositor addresses to deposit ids with their corresponding speed up requests.
   */
  public getSpeedUps(): { [depositorAddress: string]: { [depositId: string]: SpeedUpWithBlock[] } } {
    return this.speedUps;
  }

  /**
   * Find a corresponding deposit for a given fill.
   * @param fill The fill to find a corresponding deposit for.
   * @returns The corresponding deposit if found, undefined otherwise.
   */
  public getDepositForFill(fill: Fill): DepositWithBlock | undefined {
    const deposit = this.depositHashes[getRelayEventKey(fill)];
    const match = validateFillForDeposit(fill, deposit);
    if (match.valid) {
      return deposit;
    }
    return undefined;
  }

  public getFillsForDeposit(deposit: Deposit): FillWithBlock[] {
    return this.depositHashesToFills[this.getDepositHash(deposit)];
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
    const { outputAmount } = deposit;
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: outputAmount, fillCount: 0, invalidFills: [] };
    }

    const { validFills, invalidFills, unrepayableFills } = fillsForDeposit.reduce(
      (groupedFills: { validFills: Fill[]; invalidFills: Fill[]; unrepayableFills: Fill[] }, fill: Fill) => {
        if (validateFillForDeposit(fill, deposit).valid) {
          const repaymentChainId = getRepaymentChainId(fill, deposit);
          // In order to keep this function sync, we can't call verifyFillRepayment so we'll log any fills that
          // we'll have to overwrite repayment information for. This includes fills for lite chains where the
          // repayment address is invalid, and fills for non-lite chains where the repayment address is valid or
          // the repayment chain is invalid. We don't check that the origin chain is a valid EVM chain for
          // lite chain deposits yet because only EVM chains are supported on Across...for now. This means
          // this logic will have to be revisited when we add SVM to log properly.
          if (
            this.hubPoolClient &&
            !isSlowFill(fill) &&
            (!fill.relayer.isValidEvmAddress() ||
              forceDestinationRepayment(
                repaymentChainId,
                { ...deposit, quoteBlockNumber: this.hubPoolClient!.latestBlockSearched },
                this.hubPoolClient
              ))
          ) {
            groupedFills.unrepayableFills.push(fill);
          }
          // This fill is still valid and means that the deposit cannot be filled on-chain anymore, but it
          // also can be unrepayable which we should want to log.
          groupedFills.validFills.push(fill);
        } else {
          groupedFills.invalidFills.push(fill);
        }
        return groupedFills;
      },
      { validFills: [], invalidFills: [], unrepayableFills: [] }
    );

    // Log any invalid deposits with same deposit id but different params.
    const invalidFillsForDeposit = invalidFills.filter((x) => x.depositId.eq(deposit.depositId));
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
    const unrepayableFillsForDeposit = unrepayableFills.filter((x) => x.depositId.eq(deposit.depositId));
    if (unrepayableFillsForDeposit.length > 0) {
      this.logger.warn({
        at: "SpokePoolClient",
        chainId: this.chainId,
        message: "Unrepayable fills found where we need to switch repayment address and or chain",
        deposit,
        unrepayableFills: Object.fromEntries(unrepayableFillsForDeposit.map((x) => [x.relayer, x])),
        notificationPath: "across-unrepayable-fills",
      });
    }

    // If all fills are invalid we can consider this unfilled.
    if (validFills.length === 0) {
      return { unfilledAmount: outputAmount, fillCount: 0, invalidFills };
    }

    return {
      unfilledAmount: bnZero,
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
  public getDepositHash(event: { depositId: BigNumber; originChainId: number }): string {
    return `${event.depositId.toString()}-${event.originChainId}`;
  }

  /**
   * Finds the deposit id at a specific block number.
   * @param blockTag The block number to search for the deposit ID at.
   * @returns The deposit ID.
   */
  public _getDepositIdAtBlock(blockTag: number): Promise<BigNumber> {
    return getDepositIdAtBlock(this.spokePool as SpokePool, blockTag);
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
    let firstDepositId = this.firstDepositIdForSpokePool;
    if (firstDepositId.eq(MAX_BIG_INT)) {
      firstDepositId = await this.spokePool.numberOfDeposits({ blockTag: this.deploymentBlock });
      firstDepositId = BigNumber.from(firstDepositId); // Cast input to a big number.
      if (!BigNumber.isBigNumber(firstDepositId) || firstDepositId.lt(bnZero)) {
        throw new Error(`SpokePoolClient::update: Invalid first deposit id (${firstDepositId})`);
      }
    }

    const searchConfig = await this.updateSearchConfig(this.spokePool.provider);
    if (isUpdateFailureReason(searchConfig)) {
      const reason = searchConfig;
      return { success: false, reason };
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

    const { spokePool } = this;
    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: spokePool.address,
    });

    const timerStart = Date.now();
    const multicallFunctions = ["getCurrentTime", "numberOfDeposits"];
    const [multicallOutput, ...events] = await Promise.all([
      spokePool.callStatic.multicall(
        multicallFunctions.map((f) => spokePool.interface.encodeFunctionData(f)),
        { blockTag: searchConfig.toBlock }
      ),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(this.spokePool, config.filter, config.searchConfig)),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);

    const [currentTime, _numberOfDeposits] = multicallFunctions.map(
      (fn, idx) => spokePool.interface.decodeFunctionResult(fn, multicallOutput[idx])[0]
    );
    const _latestDepositId = BigNumber.from(_numberOfDeposits).sub(bnOne);

    if (!BigNumber.isBigNumber(currentTime) || currentTime.lt(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`SpokePoolClient::update: ${errMsg}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    events.forEach((events: Log[]) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: currentTime.toNumber(), // uint32
      firstDepositId,
      latestDepositId: _latestDepositId.gt(bnZero) ? _latestDepositId : bnZero,
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
    const duplicateEvents: Log[] = [];
    if (this.hubPoolClient !== null && !this.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    const update = await this._update(eventsToQuery);
    if (!update.success) {
      return;
    }
    const { events: queryResults, currentTime, searchEndBlock } = update;

    if (eventsToQuery.includes("TokensBridged")) {
      for (const event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        this.tokensBridged.push(spreadEventWithBlockNumber(event) as TokensBridged);
      }
    }

    // Performs the indexing of a deposit-like spoke pool event.
    const queryDepositEvents = async (eventName: string) => {
      const depositEvents = queryResults[eventsToQuery.indexOf(eventName)] ?? [];
      if (depositEvents.length > 0) {
        this.log(
          "debug",
          `Using ${depositEvents.length} newly queried ${eventName} deposit events for chain ${this.chainId}`,
          {
            earliestEvent: depositEvents[0].blockNumber,
          }
        );
      }

      // For each deposit, resolve its quoteTimestamp to a block number on the HubPool.
      // Don't bother filtering for uniqueness; the HubPoolClient handles this efficienctly.
      const quoteBlockNumbers = await this.getBlockNumbers(
        depositEvents.map(({ args }) => Number(args["quoteTimestamp"]))
      );
      for (const event of depositEvents) {
        const quoteBlockNumber = quoteBlockNumbers[Number(event.args["quoteTimestamp"])];

        // Derive and append the common properties that are not part of the onchain event.
        const deposit = {
          ...spreadEventWithBlockNumber(event),
          messageHash: getMessageHash(event.args.message),
          quoteBlockNumber,
          originChainId: this.chainId,
          // The following properties are placeholders to be updated immediately.
          fromLiteChain: true,
          toLiteChain: true,
        } as DepositWithBlock;

        deposit.fromLiteChain = this.isOriginLiteChain(deposit);
        deposit.toLiteChain = this.isDestinationLiteChain(deposit);

        if (deposit.outputToken.isZeroAddress()) {
          deposit.outputToken = this.getDestinationTokenForDeposit(deposit);
        }

        if (this.depositHashes[getRelayEventKey(deposit)] !== undefined) {
          // Sanity check that this event is not a duplicate, even though the relay data hash is a duplicate.
          const allDeposits = this._getDuplicateDeposits(deposit).concat(this.depositHashes[getRelayEventKey(deposit)]);
          if (allDeposits.some((e) => duplicateEvent(deposit, e))) {
            duplicateEvents.push(event);
            continue;
          }
          assign(this.duplicateDepositHashes, [getRelayEventKey(deposit)], [deposit]);
          continue;
        }
        assign(this.depositHashes, [getRelayEventKey(deposit)], deposit);

        if (deposit.depositId.lt(this.earliestDepositIdQueried) && !isUnsafeDepositId(deposit.depositId)) {
          this.earliestDepositIdQueried = deposit.depositId;
        }
        if (deposit.depositId.gt(this.latestDepositIdQueried) && !isUnsafeDepositId(deposit.depositId)) {
          this.latestDepositIdQueried = deposit.depositId;
        }
      }
    };

    for (const event of ["V3FundsDeposited", "FundsDeposited"]) {
      if (eventsToQuery.includes(event)) {
        await queryDepositEvents(event);
      }
    }

    // Performs indexing of a "speed up deposit"-like event.
    const querySpeedUpDepositEvents = (eventName: string) => {
      const speedUpEvents = queryResults[eventsToQuery.indexOf(eventName)] ?? [];

      for (const event of speedUpEvents) {
        const speedUp = { ...spreadEventWithBlockNumber(event), originChainId: this.chainId } as SpeedUpWithBlock;
        assign(this.speedUps, [speedUp.depositor, speedUp.depositId.toString()], [speedUp]);

        // Find deposit hash matching this speed up event and update the deposit data associated with the hash,
        // if the hash+data exists.
        const deposit = this.getDeposit(speedUp.depositId);

        // We can assume all deposits in this lookback window are loaded in-memory already so if the depositHash
        // is not mapped to a deposit, then we can throw away the speedup as it can't be applied to anything.
        if (isDefined(deposit)) {
          const eventKey = getRelayEventKey(deposit);
          this.depositHashes[eventKey] = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        }
      }
    };

    // Update deposits with speed up requests from depositor.
    ["RequestedSpeedUpV3Deposit", "RequestedSpeedUpDeposit"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        querySpeedUpDepositEvents(event);
      }
    });

    // Performs indexing of "requested slow fill"-like events.
    const queryRequestedSlowFillEvents = (eventName: string) => {
      const slowFillRequests = queryResults[eventsToQuery.indexOf(eventName)];
      for (const event of slowFillRequests) {
        const slowFillRequest = {
          ...spreadEventWithBlockNumber(event),
          destinationChainId: this.chainId,
        } as SlowFillRequestWithBlock;

        if (eventName === "RequestedV3SlowFill") {
          slowFillRequest.messageHash = getMessageHash(slowFillRequest.message);
        }

        const depositHash = getRelayEventKey({ ...slowFillRequest, destinationChainId: this.chainId });

        // Sanity check that this event is not a duplicate.
        if (this.slowFillRequests[depositHash] !== undefined) {
          duplicateEvents.push(event);
          continue;
        }

        this.slowFillRequests[depositHash] ??= slowFillRequest;
      }
    };

    ["RequestedV3SlowFill", "RequestedSlowFill"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        queryRequestedSlowFillEvents(event);
      }
    });

    // Performs indexing of filled relay-like events.
    const queryFilledRelayEvents = (eventName: string) => {
      const fillEvents = queryResults[eventsToQuery.indexOf(eventName)] ?? [];

      if (fillEvents.length > 0) {
        this.log("debug", `Using ${fillEvents.length} newly queried ${eventName} events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      }

      // @note The type assertions here suppress errors that might arise due to incomplete types. For now, verify via
      // test that the types are complete. A broader change in strategy for safely unpacking events will be introduced.
      for (const event of fillEvents) {
        const fill = {
          ...spreadEventWithBlockNumber(event),
          destinationChainId: this.chainId,
        } as FillWithBlock;

        if (eventName === "FilledV3Relay") {
          fill.messageHash = getMessageHash(event.args.message);
          fill.relayExecutionInfo.updatedMessageHash = getMessageHash(event.args.relayExecutionInfo.updatedMessage);
        }

        // Sanity check that this event is not a duplicate.
        const duplicateFill = this.fills[fill.originChainId]?.find((f) => duplicateEvent(fill, f));
        if (duplicateFill) {
          duplicateEvents.push(event);
          continue;
        }

        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
      }
    };

    // Update observed fills with ingested event data.
    ["FilledV3Relay", "FilledRelay"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        queryFilledRelayEvents(event);
      }
    });

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

    if (duplicateEvents.length > 0) {
      this.log("debug", "Duplicate events listed", {
        duplicateEvents,
      });
      this.log("error", "Duplicate events detected, check debug logs");
    }

    // Next iteration should start off from where this one ended.
    this.currentTime = currentTime;
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
  public static getExecutedRefundLeafL2Token(chainId: number, eventL2Token: EvmAddress): EvmAddress {
    // If execution of WETH refund leaf occurred on an OVM spoke pool, then we'll convert its l2Token from the native
    // token address to the wrapped token address. This is because the OVM_SpokePool modifies the l2TokenAddress prop
    // in _bridgeTokensToHubPool before emitting the ExecutedRelayerRefundLeaf event.
    // Here is the contract code referenced:
    // - https://github.com/across-protocol/contracts/blob/954528a4620863d1c868e54a370fd8556d5ed05c/contracts/Ovm_SpokePool.sol#L142
    if (
      (chainId === 10 || chainId === 8453) &&
      eventL2Token.toAddress().toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000"
    ) {
      return EvmAddress.fromHex("0x4200000000000000000000000000000000000006");
    } else if (chainId === 288 && eventL2Token.toAddress() === "0x4200000000000000000000000000000000000006") {
      return EvmAddress.fromHex("0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000");
    } else {
      return eventL2Token;
    }
  }

  /**
   * Resolve a given timestamp to a block number on the HubPool chain via the HubPoolClient.
   * @param timestamp A single timestamp to be resolved via the HubPoolClient.
   * @returns The block number on the HubPool chain corresponding to the supplied timestamp.
   */
  protected getBlockNumber(timestamp: number): Promise<number> {
    return this.hubPoolClient?.getBlockNumber(timestamp) ?? Promise.resolve(MAX_BIG_INT.toNumber());
  }

  /**
   * For an array of timestamps, resolve each timestamp to a block number on the HubPool chain via the HubPoolClient.
   * @param timestamps Array of timestamps to be resolved to a block number via the HubPoolClient.
   * @returns A mapping of quoteTimestamp -> HubPool block number.
   */
  protected getBlockNumbers(timestamps: number[]): Promise<{ [quoteTimestamp: number]: number }> {
    return (
      this.hubPoolClient?.getBlockNumbers(timestamps) ??
      Promise.resolve(Object.fromEntries(timestamps.map((timestamp) => [timestamp, MAX_BIG_INT.toNumber()])))
    );
  }

  /**
   * Retrieves the destination token for a given deposit.
   * @param deposit The deposit to retrieve the destination token for.
   * @returns The destination token.
   */
  protected getDestinationTokenForDeposit(deposit: DepositWithBlock): Address {
    // If there is no rate model client return address(0).
    if (!this.hubPoolClient) {
      return Address.fromHex(ZERO_ADDRESS);
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
   * Retrieves the time from the SpokePool contract at a particular block.
   * @returns The time at the specified block tag.
   */
  public async getTimeAt(blockNumber: number): Promise<number> {
    const currentTime = await this.spokePool.getCurrentTime({ blockTag: blockNumber });
    assert(BigNumber.isBigNumber(currentTime) && currentTime.lt(bnUint32Max));
    return currentTime.toNumber();
  }

  async findDeposit(depositId: BigNumber, destinationChainId: number): Promise<DepositWithBlock> {
    // Binary search for event search bounds. This way we can get the blocks before and after the deposit with
    // deposit ID = fill.depositId and use those blocks to optimize the search for that deposit.
    // Stop searches after a maximum # of searches to limit number of eth_call requests. Make an
    // eth_getLogs call on the remaining block range (i.e. the [low, high] remaining from the binary
    // search) to find the target deposit ID.
    //
    // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
    // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
    const searchBounds = await getBlockRangeForDepositId(
      depositId,
      this.deploymentBlock,
      this.latestBlockSearched,
      7,
      this
    );

    const tStart = Date.now();
    // Check both V3FundsDeposited and FundsDeposited events to look for a specified depositId.
    const [fromBlock, toBlock] = [searchBounds.low, searchBounds.high];
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
      const srcChain = getNetworkName(this.chainId);
      const dstChain = getNetworkName(destinationChainId);
      throw new Error(
        `Could not find deposit ${depositId.toString()} for ${dstChain} fill` +
          ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
      );
    }

    const deposit = {
      ...spreadEventWithBlockNumber(event),
      originChainId: this.chainId,
      quoteBlockNumber: await this.getBlockNumber(Number(event.args["quoteTimestamp"])),
      fromLiteChain: true, // To be updated immediately afterwards.
      toLiteChain: true, // To be updated immediately afterwards.
    } as DepositWithBlock;

    if (deposit.outputToken.isZeroAddress()) {
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

    return deposit;
  }

  /**
   * Determines whether a deposit originates from a lite chain.
   * @param deposit The deposit to evaluate.
   * @returns True if the deposit originates from a lite chain, false otherwise. If the hub pool client is not defined,
   *          this method will return false.
   */
  protected isOriginLiteChain(deposit: DepositWithBlock): boolean {
    return this.configStoreClient?.isChainLiteChainAtTimestamp(deposit.originChainId, deposit.quoteTimestamp) ?? false;
  }

  /**
   * Determines whether the deposit destination chain is a lite chain.
   * @param deposit The deposit to evaluate.
   * @returns True if the deposit is destined to a lite chain, false otherwise. If the hub pool client is not defined,
   *          this method will return false.
   */
  protected isDestinationLiteChain(deposit: DepositWithBlock): boolean {
    return (
      this.configStoreClient?.isChainLiteChainAtTimestamp(deposit.destinationChainId, deposit.quoteTimestamp) ?? false
    );
  }

  public async getTimestampForBlock(blockTag: number): Promise<number> {
    const block = await this.spokePool.provider.getBlock(blockTag);
    return Number(block.timestamp);
  }

  /**
   * Find the amount filled for a deposit at a particular block.
   * @param relayData Deposit information that is used to complete a fill.
   * @param blockTag Block tag (numeric or "latest") to query at.
   * @returns The amount filled for the specified deposit at the requested block (or latest).
   */
  public relayFillStatus(
    relayData: RelayData,
    blockTag?: number | "latest",
    destinationChainId?: number
  ): Promise<FillStatus> {
    return relayFillStatus(this.spokePool, relayData, blockTag, destinationChainId);
  }
}
