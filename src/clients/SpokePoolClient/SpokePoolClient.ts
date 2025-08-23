import winston from "winston";
import { utils as ethersUtils } from "ethers";
import {
  AnyObject,
  BigNumber,
  bnZero,
  DefaultLogLevels,
  DepositSearchResult,
  EventSearchConfig,
  EvmAddress,
  MAX_BIG_INT,
  MakeOptional,
  assign,
  getRelayEventKey,
  isDefined,
  isSlowFill,
  validateFillForDeposit,
  chainIsEvm,
  chainIsProd,
  Address,
  toAddressType,
  unpackDepositEvent,
  unpackFillEvent,
} from "../../utils";
import { duplicateEvent, sortEventsAscendingInPlace } from "../../utils/EventUtils";
import { CHAIN_IDs, ZERO_ADDRESS } from "../../constants";
import {
  BridgedToHubPoolWithBlock,
  ClaimedRelayerRefundWithBlock,
  Deposit,
  DepositWithBlock,
  EnabledDepositRouteWithBlock,
  Fill,
  FillStatus,
  FillWithBlock,
  RelayData,
  RelayerRefundExecutionWithBlock,
  RootBundleRelayWithBlock,
  SlowFillRequestWithBlock,
  SortableEvent,
  SpeedUpWithBlock,
  TokensBridged,
} from "../../interfaces";
import { BaseAbstractClient, UpdateFailureReason } from "../BaseAbstractClient";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";
import { getRefundInformationFromFill } from "../BundleDataClient";
import { HubPoolClient } from "../HubPoolClient";

export type SpokePoolUpdateSuccess = {
  success: true;
  currentTime: number;
  events: SortableEvent[][];
  searchEndBlock: number;
};
export type SpokePoolUpdateFailure = {
  success: false;
  reason: UpdateFailureReason;
};
export type SpokePoolUpdate = SpokePoolUpdateSuccess | SpokePoolUpdateFailure;

export const knownEventNames = [
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
  "BridgedToHubPool",
  "ClaimedRelayerRefund",
];

/**
 * SpokePoolClient is a client for the SpokePool contract. It is responsible for querying the SpokePool contract
 * for events and storing them in memory. It also provides some convenience methods for querying the stored events.
 */
export abstract class SpokePoolClient extends BaseAbstractClient {
  abstract readonly type: string;
  protected currentTime = 0;
  protected duplicateDepositHashes: { [depositHash: string]: DepositWithBlock[] } = {};
  protected depositHashesToFills: { [depositHash: string]: FillWithBlock[] } = {};
  protected speedUps: { [depositorAddress: string]: { [depositId: string]: SpeedUpWithBlock[] } } = {};
  protected slowFillRequests: { [relayDataHash: string]: SlowFillRequestWithBlock } = {};
  protected depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  protected tokensBridged: TokensBridged[] = [];
  protected rootBundleRelays: RootBundleRelayWithBlock[] = [];
  protected relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  protected claimedRelayerRefunds: ClaimedRelayerRefundWithBlock[] = [];
  protected bridgedToHubPool: BridgedToHubPoolWithBlock[] = [];
  protected configStoreClient: AcrossConfigStoreClient | undefined;
  protected invalidFills: Set<string> = new Set();
  public readonly depositHashes: { [depositHash: string]: DepositWithBlock } = {};
  public spokePoolAddress: Address | undefined;
  public fills: { [OriginChainId: number]: FillWithBlock[] } = {};

  /**
   * Creates a new SpokePoolClient.
   * @param logger A logger instance.
   * @param hubPoolClient An optional HubPoolClient instance. This is used to fetch spoke data that is not stored on the SpokePool contract but is stored on the HubPool contract.
   * @param chainId The chain ID of the chain that this client is querying.
   * @param deploymentBlock The block number that the SpokePool contract was deployed at.
   * @param eventSearchConfig An optional EventSearchConfig object that controls how far back in history the client will search for events. If not provided, the client will only search for events from the deployment block.
   */
  protected constructor(
    readonly logger: winston.Logger,
    // Can be excluded. This disables some deposit validation.
    readonly hubPoolClient: HubPoolClient | null,
    readonly chainId: number,
    public deploymentBlock: number,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 }
  ) {
    super(eventSearchConfig);
    this.firstHeightToSearch = eventSearchConfig.from;
    this.latestHeightSearched = 0;
    this.configStoreClient = hubPoolClient?.configStoreClient;
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
    const duplicateDeposits = deposits.reduce<DepositWithBlock[]>((acc, deposit) => {
      const duplicates = this._getDuplicateDeposits(deposit);
      return acc.concat(duplicates);
    }, []);
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
   * Retrieves a list of claimed relayer refunds from the SpokePool contract.
   * @returns A list of claimed relayer refunds.
   */
  public getClaimedRelayerRefunds(): ClaimedRelayerRefundWithBlock[] {
    return this.claimedRelayerRefunds;
  }

  /**
   * Retrieves a list of bridged to hub pool events from the SpokePool contract.
   * @returns A list of bridged to hub pool events.
   */
  public getBridgedToHubPoolEvents(): BridgedToHubPoolWithBlock[] {
    return this.bridgedToHubPool;
  }

  /**
   * Appends a speed up signature to a specific deposit.
   * @param deposit The deposit to append the speed up signature to.
   * @returns A new deposit instance with the speed up signature appended to the deposit.
   */
  public appendMaxSpeedUpSignatureToDeposit(deposit: DepositWithBlock): DepositWithBlock {
    const { depositId, depositor } = deposit;

    // Note: we know depositor cannot be more than 20 bytes since this is guaranteed by contracts.
    // Additionally, speed ups can only be done on EVM networks.
    const speedups = this.speedUps[depositor.toEvmAddress()]?.[depositId.toString()];
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
  public getSlowFillRequest(
    relayData: Omit<RelayData, "message"> & { messageHash: string }
  ): SlowFillRequestWithBlock | undefined {
    const hash = getRelayEventKey({ ...relayData, destinationChainId: this.chainId });
    return this.slowFillRequests[hash];
  }

  /**
   * Retrieves a list of slow fill requests for deposits from a specific origin chain ID.
   * @param originChainId The origin chain ID.
   * @returns A list of slow fill requests.
   */
  public getSlowFillRequestsForOriginChain(originChainId: number): SlowFillRequestWithBlock[] {
    return Object.values(this.slowFillRequests).filter((e) => e.originChainId === originChainId);
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
    return match.valid ? deposit : undefined;
  }

  public getFillsForDeposit(deposit: Deposit): FillWithBlock[] {
    return this.depositHashesToFills[this.getDepositHash(deposit)] ?? [];
  }

  public isDepositFilled(deposit: Deposit): boolean {
    const depositHash = this.getDepositHash(deposit);
    const fills = this.depositHashesToFills[depositHash] ?? [];

    return fills.some((fill) => validateFillForDeposit(fill, deposit).valid);
  }

  // @TODO: Remove this method after refactoring relayer repo.
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
    invalidFills: FillWithBlock[];
  } {
    const { outputAmount, originChainId } = deposit;
    const fillsForDeposit = this.depositHashesToFills[this.getDepositHash(deposit)];
    // If no fills then the full amount is remaining.
    if (fillsForDeposit === undefined || fillsForDeposit.length === 0) {
      return { unfilledAmount: outputAmount, fillCount: 0, invalidFills: [] };
    }

    const { validFills, invalidFills, unrepayableFills } = fillsForDeposit.reduce(
      (
        groupedFills: { validFills: FillWithBlock[]; invalidFills: FillWithBlock[]; unrepayableFills: FillWithBlock[] },
        fill: FillWithBlock
      ) => {
        if (validateFillForDeposit(fill, deposit).valid) {
          const fillRepaymentData = {
            ...fill,
            fromLiteChain: deposit.fromLiteChain,
          };
          const { chainToSendRefundTo: repaymentChainId } = getRefundInformationFromFill(
            fillRepaymentData,
            this.hubPoolClient!,
            this.hubPoolClient!.latestHeightSearched
          );
          // In order to keep this function sync, we can't call verifyFillRepayment so we'll log any fills where
          // the filler-specified repayment chain and repayment address is not a valid repayment upon
          // first glance. In other words, the repayment address is not a valid EVM address or the repayment chain
          // is not a valid EVM chain. In the case where the repayment address is not a valid EVM address, the dataworker
          // might be able to overwrite the repayment address to the msg.sender on the fill txn, but to keep this
          // functioon synchronous, we can't make that decision now. So this function might log some false positives.
          if (this.hubPoolClient && !isSlowFill(fill) && !fill.relayer.isValidOn(repaymentChainId)) {
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

    const logLevel = chainIsProd(originChainId) ? "warn" : "debug";
    const unrepayableFillsForDeposit = unrepayableFills.filter((x) => x.depositId.eq(deposit.depositId));
    if (unrepayableFillsForDeposit.length > 0) {
      this.logger[logLevel]({
        at: "SpokePoolClient",
        chainId: this.chainId,
        message: "Unrepayable fills found where we need to switch repayment address and or chain",
        deposit,
        unrepayableFills: Object.fromEntries(unrepayableFillsForDeposit.map((x) => [x.relayer.toNative(), x])),
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

  protected canResolveZeroAddressOutputToken(
    deposit: Pick<DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber" | "destinationChainId">
  ): boolean {
    if (
      !this.hubPoolClient?.l2TokenHasPoolRebalanceRoute(
        deposit.inputToken,
        deposit.originChainId,
        deposit.quoteBlockNumber
      )
    ) {
      return false;
    } else {
      const l1Token = this.hubPoolClient?.getL1TokenForL2TokenAtBlock(
        deposit.inputToken,
        deposit.originChainId,
        deposit.quoteBlockNumber
      );
      return this.hubPoolClient.l2TokenEnabledForL1TokenAtBlock(
        l1Token,
        deposit.destinationChainId,
        deposit.quoteBlockNumber
      );
    }
  }

  /**
   * A wrapper over the `_update` method that handles errors and logs. This method additionally calls into the
   * HubPoolClient to update the state of this client with data from the HubPool contract.
   * @param eventsToQuery An optional list of events to query. If not provided, all events will be queried.
   * @returns A Promise that resolves to a SpokePoolUpdate object.
   * @note This method is the primary method for updating the state of this client externally.
   * @see _update
   */
  public async update(eventsToQuery = this._queryableEventNames()): Promise<void> {
    const duplicateEvents: SortableEvent[] = [];
    if (this.hubPoolClient !== null && !this.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    const update = await this._update(eventsToQuery);
    if (!update.success) {
      return;
    }
    const { events: queryResults, currentTime, searchEndBlock } = update;

    if (eventsToQuery.includes("TokensBridged")) {
      for (const _event of queryResults[eventsToQuery.indexOf("TokensBridged")]) {
        const event = _event as Omit<TokensBridged, "l2TokenAddress"> & {
          l2TokenAddress: string;
        };
        this.tokensBridged.push({
          ...event,
          l2TokenAddress: toAddressType(event.l2TokenAddress, this.chainId),
        });
      }
    }

    // Performs the indexing of a deposit-like spoke pool event.
    const queryDepositEvents = async (eventName: string) => {
      const depositEvents = (queryResults[eventsToQuery.indexOf(eventName)] ?? []).map((event) =>
        unpackDepositEvent(event, this.chainId)
      );

      // For each deposit, resolve its quoteTimestamp to a block number on the HubPool.
      // Don't bother filtering for uniqueness; the HubPoolClient handles this efficienctly.
      const quoteBlockNumbers = await this.getBlockNumbers(depositEvents.map((e) => e.quoteTimestamp));
      for (const event of depositEvents) {
        const quoteBlockNumber = quoteBlockNumbers[Number(event.quoteTimestamp)];

        // Derive and append the common properties that are not part of the onchain event.
        const outputToken = event.outputToken.isZeroAddress()
          ? this.getDestinationTokenForDeposit({ ...event, quoteBlockNumber })
          : event.outputToken;

        const deposit = {
          ...event,
          outputToken,
          quoteBlockNumber,
          fromLiteChain: this.isOriginLiteChain(event),
          toLiteChain: this.isDestinationLiteChain(event),
        } satisfies DepositWithBlock;

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
      }
    };

    for (const event of ["FundsDeposited"]) {
      if (eventsToQuery.includes(event)) {
        await queryDepositEvents(event);
      }
    }

    // Performs indexing of a "speed up deposit"-like event.
    const querySpeedUpDepositEvents = (eventName: string) => {
      const speedUpEvents = (queryResults[eventsToQuery.indexOf(eventName)] ?? [])
        .map((_event) => {
          const event = _event as Omit<SpeedUpWithBlock, "depositor" | "updatedRecipient"> & {
            depositor: string;
            updatedRecipient: string;
          };

          const invalid = [event.depositor, event.updatedRecipient].some(
            (addr) => !EvmAddress.validate(ethersUtils.arrayify(addr))
          );
          if (invalid) {
            return;
          }

          return {
            ...event,
            depositor: EvmAddress.from(event.depositor),
            updatedRecipient: EvmAddress.from(event.updatedRecipient),
          } as SpeedUpWithBlock;
        })
        .filter(isDefined);

      for (const event of speedUpEvents) {
        const speedUp = {
          ...event,
          originChainId: this.chainId,
        };
        assign(this.speedUps, [speedUp.depositor.toEvmAddress(), speedUp.depositId.toString()], [speedUp]);

        // Find deposit hash matching this speed up event and update the deposit data associated with the hash,
        // if the hash+data exists. nb. Relying on depositId alone can produce collisions on deterministic deposit IDs.
        const deposit = this.getDeposit(speedUp.depositId);

        // SpeedUp requests are only supported EVM -> EVM.
        if (isDefined(deposit) && chainIsEvm(deposit.destinationChainId) && deposit.depositor.eq(speedUp.depositor)) {
          // We can assume all deposits in this lookback window are loaded in-memory already so if the depositHash
          // is not mapped to a deposit, then we can throw away the speedup as it can't be applied to anything.
          const eventKey = getRelayEventKey(deposit);
          this.depositHashes[eventKey] = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        }
      }
    };

    // Update deposits with speed up requests from depositor.
    ["RequestedSpeedUpDeposit"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        querySpeedUpDepositEvents(event);
      }
    });

    // Performs indexing of "requested slow fill"-like events.
    const queryRequestedSlowFillEvents = (eventName: string) => {
      const destinationChainId = this.chainId;
      const slowFillRequests = (queryResults[eventsToQuery.indexOf(eventName)] ?? []).map((_event) => {
        const event = _event as Omit<
          SlowFillRequestWithBlock,
          "depositor" | "recipient" | "inputToken" | "outputToken" | "exclusiveRelayer"
        > & {
          depositor: string;
          recipient: string;
          inputToken: string;
          outputToken: string;
          exclusiveRelayer: string;
        };
        return {
          ...event,
          destinationChainId,
          depositor: toAddressType(event.depositor, event.originChainId),
          recipient: toAddressType(event.recipient, destinationChainId),
          inputToken: toAddressType(event.inputToken, destinationChainId),
          outputToken: toAddressType(event.outputToken, destinationChainId),
          exclusiveRelayer: toAddressType(event.exclusiveRelayer, destinationChainId),
        } satisfies SlowFillRequestWithBlock;
      });

      for (const slowFillRequest of slowFillRequests) {
        const depositHash = getRelayEventKey(slowFillRequest);

        // Sanity check that this event is not a duplicate.
        if (this.slowFillRequests[depositHash] !== undefined) {
          duplicateEvents.push(slowFillRequest);
          continue;
        }

        this.slowFillRequests[depositHash] ??= slowFillRequest;
      }
    };

    ["RequestedSlowFill"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        queryRequestedSlowFillEvents(event);
      }
    });

    // Performs indexing of filled relay-like events.
    const queryFilledRelayEvents = (eventName: string) => {
      const fillEvents = (queryResults[eventsToQuery.indexOf(eventName)] ?? []).map((event) =>
        unpackFillEvent(event, this.chainId)
      );
      if (fillEvents.length > 0) {
        this.log("debug", `Using ${fillEvents.length} newly queried ${eventName} events for chain ${this.chainId}`, {
          earliestEvent: fillEvents[0].blockNumber,
        });
      }

      // @note The type assertions here suppress errors that might arise due to incomplete types. For now, verify via
      // test that the types are complete. A broader change in strategy for safely unpacking events will be introduced.
      for (const fill of fillEvents) {
        // Sanity check that this event is not a duplicate.
        const duplicateFill = this.fills[fill.originChainId]?.find((f) => duplicateEvent(fill, f));
        if (duplicateFill) {
          duplicateEvents.push(fill);
          continue;
        }

        assign(this.fills, [fill.originChainId], [fill]);
        assign(this.depositHashesToFills, [this.getDepositHash(fill)], [fill]);
      }
    };

    // Update observed fills with ingested event data.
    ["FilledRelay"].forEach((event) => {
      if (eventsToQuery.includes(event)) {
        queryFilledRelayEvents(event);
      }
    });

    if (eventsToQuery.includes("EnabledDepositRoute")) {
      const enableDepositsEvents = queryResults[eventsToQuery.indexOf("EnabledDepositRoute")].map((_event) => {
        const event = _event as Omit<EnabledDepositRouteWithBlock, "originToken"> & { originToken: string };
        return {
          ...event,
          originToken: toAddressType(event.originToken, CHAIN_IDs.MAINNET),
        } as EnabledDepositRouteWithBlock;
      });

      for (const event of enableDepositsEvents) {
        assign(this.depositRoutes, [event.originToken.toBytes32(), event.destinationChainId], event.enabled);
      }
    }

    if (eventsToQuery.includes("RelayedRootBundle")) {
      const relayedRootBundleEvents = queryResults[
        eventsToQuery.indexOf("RelayedRootBundle")
      ] as RootBundleRelayWithBlock[];
      for (const event of relayedRootBundleEvents) {
        this.rootBundleRelays.push(event);
      }
    }

    if (eventsToQuery.includes("ExecutedRelayerRefundRoot")) {
      const refundEvents = queryResults[eventsToQuery.indexOf("ExecutedRelayerRefundRoot")];
      for (const _event of refundEvents) {
        const event = _event as Omit<RelayerRefundExecutionWithBlock, "l2TokenAddress" | "refundAddresses"> & {
          l2TokenAddress: string;
          refundAddresses: string[];
        };
        this.relayerRefundExecutions.push({
          ...event,
          l2TokenAddress: toAddressType(event.l2TokenAddress, this.chainId),
          refundAddresses: event.refundAddresses.map((addr) => toAddressType(addr, this.chainId)),
        });
      }
    }

    if (eventsToQuery.includes("ClaimedRelayerRefund")) {
      const claimedRelayerRefundEvents = (queryResults[eventsToQuery.indexOf("ClaimedRelayerRefund")] ??
        []) as (ClaimedRelayerRefundWithBlock & { claimAmount?: BigNumber })[];
      for (const event of claimedRelayerRefundEvents) {
        this.claimedRelayerRefunds.push({
          ...event,
          amount: event.amount || event.claimAmount, // Note: This field is named differently in EVM and SVM
        });
      }
    }

    if (eventsToQuery.includes("BridgedToHubPool")) {
      const bridgedToHubPoolEvents = (queryResults[eventsToQuery.indexOf("BridgedToHubPool")] ??
        []) as (BridgedToHubPoolWithBlock & { amount?: BigNumber })[];
      for (const event of bridgedToHubPoolEvents) {
        this.bridgedToHubPool.push(event);
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
    this.latestHeightSearched = searchEndBlock;
    this.firstHeightToSearch = searchEndBlock + 1;
    this.eventSearchConfig.to = undefined; // Caller can re-set on subsequent updates if necessary
    this.isUpdated = true;
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, {
      nextFirstHeightToSearch: this.firstHeightToSearch,
    });
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
  protected getDestinationTokenForDeposit(
    deposit: Pick<DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber" | "destinationChainId">
  ): Address {
    if (!this.canResolveZeroAddressOutputToken(deposit)) {
      return toAddressType(ZERO_ADDRESS, CHAIN_IDs.MAINNET);
    }
    // L1 token should be resolved if we get here:
    const l1Token = this.hubPoolClient!.getL1TokenForL2TokenAtBlock(
      deposit.inputToken,
      deposit.originChainId,
      deposit.quoteBlockNumber
    )!;
    const counterpartToken = this.hubPoolClient!.getL2TokenForL1TokenAtBlock(
      l1Token,
      deposit.destinationChainId,
      deposit.quoteBlockNumber
    );
    return counterpartToken ?? toAddressType(ZERO_ADDRESS, CHAIN_IDs.MAINNET);
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
   * Determines whether a deposit originates from a lite chain.
   * @param deposit The deposit to evaluate.
   * @returns True if the deposit originates from a lite chain, false otherwise. If the hub pool client is not defined,
   *          this method will return false.
   */
  protected isOriginLiteChain(deposit: Pick<DepositWithBlock, "originChainId" | "quoteTimestamp">): boolean {
    return this.configStoreClient?.isChainLiteChainAtTimestamp(deposit.originChainId, deposit.quoteTimestamp) ?? false;
  }

  /**
   * Determines whether the deposit destination chain is a lite chain.
   * @param deposit The deposit to evaluate.
   * @returns True if the deposit is destined to a lite chain, false otherwise. If the hub pool client is not defined,
   *          this method will return false.
   */
  protected isDestinationLiteChain(deposit: Pick<DepositWithBlock, "destinationChainId" | "quoteTimestamp">): boolean {
    return (
      this.configStoreClient?.isChainLiteChainAtTimestamp(deposit.destinationChainId, deposit.quoteTimestamp) ?? false
    );
  }

  // ///////////////////////
  // // ABSTRACT METHODS //
  // ///////////////////////

  /**
   * Returns a list of event names that are queryable for the SpokePoolClient.
   * @returns A list of event names that are queryable for the SpokePoolClient.
   */
  public abstract _queryableEventNames(): string[];

  /**
   * Performs an update to refresh the state of this client. This will query the SpokePool contract for new events
   * and store them in memory. This method is the primary method for updating the state of this client.
   * @param eventsToQuery An optional list of events to query. If not provided, all events will be queried.
   * @returns A Promise that resolves to a SpokePoolUpdate object.
   */
  protected abstract _update(eventsToQuery: string[]): Promise<SpokePoolUpdate>;

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
  public abstract getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number>;

  /**
   * Retrieves the timestamp for a given block number.
   * @param blockTag The block number to retrieve the timestamp for.
   * @returns The timestamp for the given block number.
   */
  public abstract getTimestampForBlock(blockTag: number): Promise<number>;

  /**
   * Retrieves the time from the SpokePool contract at a particular block.
   * @returns The time at the specified block tag.
   */
  public abstract getTimeAt(blockNumber: number): Promise<number>;

  /**
   * For a given origin chain depositId, resolve the corresponding Deposit.
   * Note: This method can only be used for depositIds within the non-deterministic range (0 < depositId < 2^32 - 1).
   * @param depositId Deposit ID of the deposit to resolve.
   * @returns A DepositSearchResult instance.
   */
  public abstract findDeposit(depositId: BigNumber): Promise<DepositSearchResult>;

  /**
   * Retrieves the fill status for a given relay data.
   * @param relayData The relay data to retrieve the fill status for.
   * @param atHeight The height at which to query the fill status.
   * @returns The fill status for the given relay data.
   */
  public abstract relayFillStatus(relayData: RelayData, atHeight?: number): Promise<FillStatus>;

  /**
   * Retrieves the fill status for an array of given relay data.
   * @param relayData The array relay data to retrieve the fill status for.
   * @param atHeight The height at which to query the fill status.
   * @returns The fill status for each of the given relay data.
   */
  public abstract fillStatusArray(relayData: RelayData[], atHeight?: number): Promise<(FillStatus | undefined)[]>;
}
