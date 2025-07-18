import assert from "assert";
import _ from "lodash";
import {
  ProposedRootBundle,
  SlowFillRequestWithBlock,
  SpokePoolClientsByChain,
  FillType,
  FillStatus,
  LoadDataReturnValue,
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleFillV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
  Clients,
  CombinedRefunds,
  FillWithBlock,
  Deposit,
  DepositWithBlock,
} from "../../interfaces";
import { SpokePoolClient } from "..";
import { findFillEvent as findEvmFillEvent } from "../../arch/evm";
import { findFillEvent as findSvmFillEvent } from "../../arch/svm";
import {
  BigNumber,
  bnZero,
  queryHistoricalDepositForFill,
  assign,
  fixedPointAdjustment,
  isDefined,
  toBN,
  forEachAsync,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  getRelayEventKey,
  isSlowFill,
  mapAsync,
  bnUint32Max,
  isZeroValueDeposit,
  isZeroValueFillOrSlowFillRequest,
  duplicateEvent,
  invalidOutputToken,
  Address,
  getNetworkName,
  toBytes32,
  convertRelayDataParamsToBytes32,
  convertFillParamsToBytes32,
} from "../../utils";
import winston from "winston";
import {
  BundleDataSS,
  getEndBlockBuffers,
  getRefundInformationFromFill,
  getRefundsFromBundle,
  getWidestPossibleExpectedBlockRange,
  isChainDisabled,
  prettyPrintV3SpokePoolEvents,
  V3DepositWithBlock,
  V3FillWithBlock,
  verifyFillRepayment,
} from "./utils";
import { isEVMSpokePoolClient, isSVMSpokePoolClient } from "../SpokePoolClient";
import { SpokePoolManager } from "../SpokePoolClient/SpokePoolClientManager";

// max(uint256) - 1
export const INFINITE_FILL_DEADLINE = bnUint32Max;

type DataCache = Record<string, Promise<LoadDataReturnValue>>;

// V3 dictionary helper functions
function updateExpiredDepositsV3(dict: ExpiredDepositsToRefundV3, deposit: V3DepositWithBlock): void {
  // A deposit refund for a deposit is invalid if the depositor has a bytes32 address input for an EVM chain. It is valid otherwise.
  if (!deposit.depositor.isValidOn(deposit.originChainId)) {
    return;
  }

  const { originChainId, inputToken } = deposit;
  dict[originChainId] ??= {};
  dict[originChainId][inputToken.toBytes32()] ??= [];
  dict[originChainId][inputToken.toBytes32()].push(deposit);
}

function updateBundleDepositsV3(dict: BundleDepositsV3, deposit: V3DepositWithBlock): void {
  const { originChainId, inputToken } = deposit;
  dict[originChainId] ??= {};
  dict[originChainId][inputToken.toBytes32()] ??= [];
  dict[originChainId][inputToken.toBytes32()].push(deposit);
}

function updateBundleFillsV3(
  dict: BundleFillsV3,
  fill: V3FillWithBlock,
  lpFeePct: BigNumber,
  repaymentChainId: number,
  repaymentToken: Address,
  repaymentAddress: Address
): void {
  // We shouldn't pass any unrepayable fills into this function, so we perform an extra safety check.
  if (!fill.relayer.isValidOn(repaymentChainId)) {
    return;
  }

  dict[repaymentChainId] ??= {};
  dict[repaymentChainId][repaymentToken.toBytes32()] ??= {
    fills: [],
    totalRefundAmount: bnZero,
    realizedLpFees: bnZero,
    refunds: {},
  };

  const bundleFill: BundleFillV3 = { ...fill, lpFeePct, relayer: repaymentAddress };

  // Add all fills, slow and fast, to dictionary.
  assign(dict, [repaymentChainId, repaymentToken.toBytes32(), "fills"], [bundleFill]);

  // All fills update the bundle LP fees.
  const refundObj = dict[repaymentChainId][repaymentToken.toBytes32()];
  const realizedLpFee = bundleFill.inputAmount.mul(bundleFill.lpFeePct).div(fixedPointAdjustment);
  refundObj.realizedLpFees = refundObj.realizedLpFees ? refundObj.realizedLpFees.add(realizedLpFee) : realizedLpFee;

  // Only fast fills get refunded.
  if (!isSlowFill(bundleFill)) {
    const refundAmount = bundleFill.inputAmount.mul(fixedPointAdjustment.sub(lpFeePct)).div(fixedPointAdjustment);
    refundObj.totalRefundAmount = refundObj.totalRefundAmount
      ? refundObj.totalRefundAmount.add(refundAmount)
      : refundAmount;

    // Instantiate dictionary if it doesn't exist.
    refundObj.refunds ??= {};

    if (refundObj.refunds[bundleFill.relayer.toBytes32()]) {
      refundObj.refunds[bundleFill.relayer.toBytes32()] =
        refundObj.refunds[bundleFill.relayer.toBytes32()].add(refundAmount);
    } else {
      refundObj.refunds[bundleFill.relayer.toBytes32()] = refundAmount;
    }
  }
}

function updateBundleExcessSlowFills(
  dict: BundleExcessSlowFills,
  deposit: V3DepositWithBlock & { lpFeePct: BigNumber }
): void {
  const { destinationChainId, outputToken } = deposit;
  dict[destinationChainId] ??= {};
  dict[destinationChainId][outputToken.toBytes32()] ??= [];
  dict[destinationChainId][outputToken.toBytes32()].push(deposit);
}

function updateBundleSlowFills(dict: BundleSlowFills, deposit: V3DepositWithBlock & { lpFeePct: BigNumber }): void {
  if (!deposit.recipient.isValidOn(deposit.destinationChainId)) {
    return;
  }

  const { destinationChainId, outputToken } = deposit;
  dict[destinationChainId] ??= {};
  dict[destinationChainId][outputToken.toBytes32()] ??= [];
  dict[destinationChainId][outputToken.toBytes32()].push(deposit);
}

// @notice Shared client for computing data needed to construct or validate a bundle.
export class BundleDataClient {
  private loadDataCache: DataCache = {};
  private arweaveDataCache: Record<string, Promise<LoadDataReturnValue | undefined>> = {};

  private bundleTimestampCache: Record<string, { [chainId: number]: number[] }> = {};
  readonly spokePoolClientManager: SpokePoolManager;

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: Clients,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {}
  ) {
    this.spokePoolClientManager = new SpokePoolManager(logger, spokePoolClients);
  }

  // This should be called whenever it's possible that the loadData information for a block range could have changed.
  // For instance, if the spoke or hub clients have been updated, it probably makes sense to clear this to be safe.
  clearCache(): void {
    this.loadDataCache = {};
  }

  private async loadDataFromCache(key: string): Promise<LoadDataReturnValue> {
    // Always return a deep cloned copy of object stored in cache. Since JS passes by reference instead of value, we
    // want to minimize the risk that the programmer accidentally mutates data in the cache.
    return _.cloneDeep(await this.loadDataCache[key]);
  }

  getBundleTimestampsFromCache(key: string): undefined | { [chainId: number]: number[] } {
    if (this.bundleTimestampCache[key]) {
      return _.cloneDeep(this.bundleTimestampCache[key]);
    }
    return undefined;
  }

  setBundleTimestampsInCache(key: string, timestamps: { [chainId: number]: number[] }): void {
    this.bundleTimestampCache[key] = timestamps;
  }

  static getArweaveClientKey(blockRangesForChains: number[][]): string {
    // As a unique key for this bundle, use the bundle mainnet end block, which should
    // never be duplicated between bundles as long as thebundle block range
    // always progresses forwards, which I think is a safe assumption. Other chains might pause
    // but mainnet should never pause.
    return blockRangesForChains[0][1].toString();
  }

  private getArweaveBundleDataClientKey(blockRangesForChains: number[][]): string {
    return `bundles-${BundleDataClient.getArweaveClientKey(blockRangesForChains)}`;
  }

  private async loadPersistedDataFromArweave(
    blockRangesForChains: number[][]
  ): Promise<LoadDataReturnValue | undefined> {
    if (!isDefined(this.clients?.arweaveClient)) {
      return undefined;
    }
    const start = performance.now();
    const persistedData = await this.clients.arweaveClient.getByTopic(
      this.getArweaveBundleDataClientKey(blockRangesForChains),
      BundleDataSS
    );
    // If there is no data or the data is empty, return undefined because we couldn't
    // pull info from the Arweave persistence layer.
    if (!isDefined(persistedData) || persistedData.length < 1) {
      return undefined;
    }

    // A converter function to account for the fact that our SuperStruct schema does not support numeric
    // keys in records. Fundamentally, this is a limitation of superstruct itself.
    const convertTypedStringRecordIntoNumericRecord = <UnderlyingType>(
      data: Record<string, Record<string, UnderlyingType>>
    ): Record<number, Record<string, UnderlyingType>> =>
      Object.keys(data).reduce(
        (acc, chainId) => {
          acc[Number(chainId)] = data[chainId];
          return acc;
        },
        {} as Record<number, Record<string, UnderlyingType>>
      );

    const convertSortableEventFieldsIntoRequiredFields = <
      T extends {
        txnIndex?: number;
        transactionIndex?: number;
        txnRef?: string;
        transactionHash?: string;
      },
    >(
      data: T[]
    ): Array<
      Omit<T, "txnIndex" | "transactionIndex" | "txnRef" | "transactionHash"> & {
        txnIndex: number;
        txnRef: string;
      }
    > => {
      return data.map((item) => {
        // For txnIndex/transactionIndex: throw if both are defined or both are missing.
        if (
          (item.txnIndex !== undefined && item.transactionIndex !== undefined) ||
          (item.txnIndex === undefined && item.transactionIndex === undefined)
        ) {
          throw new Error("Either txnIndex or transactionIndex must be defined, but not both.");
        }

        // For txnRef/transactionHash: throw if both are defined or both are missing.
        if (
          (item.txnRef !== undefined && item.transactionHash !== undefined) ||
          (item.txnRef === undefined && item.transactionHash === undefined)
        ) {
          throw new Error("Either txnRef or transactionHash must be defined, but not both.");
        }

        // Destructure the fields we don't need anymore
        const { txnIndex, transactionIndex, txnRef, transactionHash, ...rest } = item;

        // Return a new object with normalized fields.
        // The non-null assertion (!) is safe here because our conditions ensure that one of each pair is defined.
        return {
          ...rest,
          txnIndex: txnIndex ?? transactionIndex!,
          txnRef: txnRef ?? transactionHash!,
        };
      });
    };

    const convertEmbeddedSortableEventFieldsIntoRequiredFields = <
      T extends {
        txnIndex?: number;
        transactionIndex?: number;
        txnRef?: string;
        transactionHash?: string;
      },
    >(
      data: Record<string, Record<string, T[]>>
    ) => {
      return Object.fromEntries(
        Object.entries(data).map(([chainId, tokenData]) => [
          chainId,
          Object.fromEntries(
            Object.entries(tokenData).map(([token, data]) => [
              token,
              convertSortableEventFieldsIntoRequiredFields(data),
            ])
          ),
        ])
      );
    };

    const data = persistedData[0].data;

    // This section processes and transforms bundle data loaded from Arweave storage into the correct format:
    // 1. Each field (bundleFillsV3, expiredDepositsToRefundV3, etc.) contains nested records keyed by chainId and token
    // 2. The chainId keys are converted from strings to numbers using convertTypedStringRecordIntoNumericRecord
    // 3. For arrays of events (fills, deposits, etc.), the transaction fields are normalized:
    //    - txnIndex/transactionIndex -> txnIndex
    //    - txnRef/transactionHash -> txnRef
    //    This ensures consistent field names across all event objects
    // 4. The data structure maintains all other fields like refunds, totalRefundAmount, and realizedLpFees
    const bundleData = {
      bundleFillsV3: convertTypedStringRecordIntoNumericRecord(
        Object.fromEntries(
          Object.entries(data.bundleFillsV3).map(([chainId, tokenData]) => [
            chainId,
            Object.fromEntries(
              Object.entries(tokenData).map(([token, data]) => [
                token,
                {
                  refunds: Object.fromEntries(
                    Object.entries(data.refunds).map(([refundAddress, refund]) => [toBytes32(refundAddress), refund])
                  ),
                  totalRefundAmount: data.totalRefundAmount,
                  realizedLpFees: data.realizedLpFees,
                  fills: convertSortableEventFieldsIntoRequiredFields(data.fills),
                },
              ])
            ),
          ])
        )
      ),
      expiredDepositsToRefundV3: convertTypedStringRecordIntoNumericRecord(
        convertEmbeddedSortableEventFieldsIntoRequiredFields(data.expiredDepositsToRefundV3)
      ),
      bundleDepositsV3: convertTypedStringRecordIntoNumericRecord(
        convertEmbeddedSortableEventFieldsIntoRequiredFields(data.bundleDepositsV3)
      ),
      unexecutableSlowFills: convertTypedStringRecordIntoNumericRecord(
        convertEmbeddedSortableEventFieldsIntoRequiredFields(data.unexecutableSlowFills)
      ),
      bundleSlowFillsV3: convertTypedStringRecordIntoNumericRecord(
        convertEmbeddedSortableEventFieldsIntoRequiredFields(data.bundleSlowFillsV3)
      ),
    };
    this.logger.debug({
      at: "BundleDataClient#loadPersistedDataFromArweave",
      message: `Loaded persisted data from Arweave in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRanges: JSON.stringify(blockRangesForChains),
      bundleData: prettyPrintV3SpokePoolEvents(
        bundleData.bundleDepositsV3,
        bundleData.bundleFillsV3,
        bundleData.bundleSlowFillsV3,
        bundleData.expiredDepositsToRefundV3,
        bundleData.unexecutableSlowFills
      ),
    });
    return bundleData;
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  async getPendingRefundsFromValidBundles(): Promise<CombinedRefunds[]> {
    const refunds = [];
    if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("BundleDataClient::getPendingRefundsFromValidBundles HubPoolClient not updated.");
    }

    const bundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
      this.clients.hubPoolClient.latestHeightSearched
    );
    if (bundle !== undefined) {
      refunds.push(await this.getPendingRefundsFromBundle(bundle));
    } // No more valid bundles in history!
    return refunds;
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  // Return refunds from input bundle.
  async getPendingRefundsFromBundle(bundle: ProposedRootBundle): Promise<CombinedRefunds> {
    const nextBundleMainnetStartBlock = this.clients.hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients.hubPoolClient.latestHeightSearched,
      this.clients.hubPoolClient.chainId
    );
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);

    // Reconstruct latest bundle block range.
    const bundleEvaluationBlockRanges = getImpliedBundleBlockRanges(
      this.clients.hubPoolClient,
      this.clients.configStoreClient,
      bundle
    );
    let combinedRefunds: CombinedRefunds;
    // Here we don't call loadData because our fallback is to approximate refunds if we don't have arweave data, rather
    // than use the much slower loadData to compute all refunds. We don't need to consider slow fills or deposit
    // expiries here so we can skip some steps. We also don't need to compute LP fees as they should be small enough
    // so as not to affect this approximate refund count.
    const arweaveData = await this.loadArweaveData(bundleEvaluationBlockRanges);
    if (!isDefined(arweaveData)) {
      combinedRefunds = await this.getApproximateRefundsForBlockRange(chainIds, bundleEvaluationBlockRanges);
    } else {
      const { bundleFillsV3, expiredDepositsToRefundV3 } = arweaveData;
      combinedRefunds = getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3);
      // If we don't have a spoke pool client for a chain, then we won't be able to deduct refunds correctly for this
      // chain. For most of the pending bundle's liveness period, these past refunds are already executed so this is
      // a reasonable assumption. This empty refund chain also matches what the alternative
      // `getApproximateRefundsForBlockRange` would return.
      Object.keys(combinedRefunds).forEach((chainId) => {
        if (!this.spokePoolClientManager.getClient(Number(chainId))) {
          delete combinedRefunds[Number(chainId)];
        }
      });
    }

    // The latest proposed bundle's refund leaves might have already been partially or entirely executed.
    // We have to deduct the executed amounts from the total refund amounts.
    return this.deductExecutedRefunds(combinedRefunds, bundle);
  }

  // @dev This helper function should probably be moved to the InventoryClient
  async getApproximateRefundsForBlockRange(chainIds: number[], blockRanges: number[][]): Promise<CombinedRefunds> {
    const refundsForChain: CombinedRefunds = {};
    const bundleEndBlockForMainnet = blockRanges[0][1];
    for (const chainId of chainIds) {
      const spokePoolClient = this.spokePoolClientManager.getClient(chainId);
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      const chainIndex = chainIds.indexOf(chainId);
      // @dev This function does not account for pre-fill refunds as it is optimized for speed. The way to detect
      // pre-fill refunds is to load all deposits that are unmatched by fills in the spoke pool client's memory
      // and then query the FillStatus on-chain, but that might slow this function down too much. For now, we
      // will live with this expected inaccuracy as it should be small. The pre-fill would have to precede the deposit
      // by more than the caller's event lookback window which is expected to be unlikely.
      const fillsToCount = spokePoolClient.getFills().filter((fill) => {
        if (
          fill.blockNumber < blockRanges[chainIndex][0] ||
          fill.blockNumber > blockRanges[chainIndex][1] ||
          isZeroValueFillOrSlowFillRequest(fill) ||
          invalidOutputToken(fill)
        ) {
          return false;
        }

        const originSpokePoolClient = this.spokePoolClientManager.getClient(fill.originChainId);
        // If origin spoke pool client isn't defined, we can't validate it.
        if (!isDefined(originSpokePoolClient)) {
          return false;
        }
        const matchingDeposit = originSpokePoolClient.getDeposit(fill.depositId);
        const hasMatchingDeposit =
          matchingDeposit !== undefined && getRelayEventKey(fill) === getRelayEventKey(matchingDeposit);
        return hasMatchingDeposit;
      });
      await forEachAsync(fillsToCount, async (_fill) => {
        const originChain = getNetworkName(_fill.originChainId);
        const originSpokePoolClient = this.spokePoolClientManager.getClient(_fill.originChainId);
        assert(isDefined(originSpokePoolClient), `No SpokePoolClient for chain ${originChain}`);
        const matchingDeposit = originSpokePoolClient.getDeposit(_fill.depositId);
        assert(
          isDefined(matchingDeposit),
          `No ${originChain} deposit found for ${getNetworkName(_fill.destinationChainId)} fill ${_fill.depositId}`
        );

        const spokeClient = this.spokePoolClientManager.getClient(_fill.destinationChainId);
        assert(
          isDefined(spokeClient),
          `SpokePoolClient for ${getNetworkName(_fill.destinationChainId)} not found for fill.`
        );

        let provider;
        if (isEVMSpokePoolClient(spokeClient)) {
          provider = spokeClient.spokePool.provider;
        } else if (isSVMSpokePoolClient(spokeClient)) {
          provider = spokeClient.svmEventsClient.getRpc();
        }
        const fill = await verifyFillRepayment(
          _fill,
          provider!,
          matchingDeposit,
          this.clients.hubPoolClient,
          bundleEndBlockForMainnet
        );
        if (!isDefined(fill)) {
          return;
        }
        const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
          {
            ...fill,
            fromLiteChain: matchingDeposit.fromLiteChain,
          },
          this.clients.hubPoolClient,
          bundleEndBlockForMainnet
        );
        // Assume that lp fees are 0 for the sake of speed. In the future we could batch compute
        // these or make hardcoded assumptions based on the origin-repayment chain direction. This might result
        // in slight over estimations of refunds, but its not clear whether underestimating or overestimating is
        // worst from the relayer's perspective.
        const { relayer, inputAmount: refundAmount } = fill;
        refundsForChain[chainToSendRefundTo] ??= {};
        refundsForChain[chainToSendRefundTo][repaymentToken.toBytes32()] ??= {};
        const existingRefundAmount =
          refundsForChain[chainToSendRefundTo][repaymentToken.toBytes32()][relayer.toBytes32()] ?? bnZero;
        refundsForChain[chainToSendRefundTo][repaymentToken.toBytes32()][relayer.toBytes32()] =
          existingRefundAmount.add(refundAmount);
      });
    }
    return refundsForChain;
  }

  getUpcomingDepositAmount(chainId: number, l2Token: Address, latestBlockToSearch: number): BigNumber {
    const spokePoolClient = this.spokePoolClientManager.getClient(chainId);
    if (!isDefined(spokePoolClient)) {
      return toBN(0);
    }
    return spokePoolClient
      .getDeposits()
      .filter((deposit) => deposit.blockNumber > latestBlockToSearch && deposit.inputToken.eq(l2Token))
      .reduce((acc, deposit) => {
        return acc.add(deposit.inputAmount);
      }, toBN(0));
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  // Return refunds from the next valid bundle. This will contain any refunds that have been sent but are not included
  // in a valid bundle with all of its leaves executed. This contains refunds from:
  // - Bundles that passed liveness but have not had all of their pool rebalance leaves executed.
  // - Bundles that are pending liveness
  // - Fills sent after the pending, but not validated, bundle
  async getNextBundleRefunds(): Promise<CombinedRefunds[]> {
    const hubPoolClient = this.clients.hubPoolClient;
    const nextBundleMainnetStartBlock = hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      hubPoolClient.latestHeightSearched,
      hubPoolClient.chainId
    );
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
    const combinedRefunds: CombinedRefunds[] = [];

    // @dev: If spoke pool client is undefined for a chain, then the end block will be null or undefined, which
    // should be handled gracefully and effectively cause this function to ignore refunds for the chain.
    let widestBundleBlockRanges = await getWidestPossibleExpectedBlockRange(
      chainIds,
      this.spokePoolClientManager.getSpokePoolClients(),
      getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestHeightSearched,
      this.clients.configStoreClient.getEnabledChains(this.clients.hubPoolClient.latestHeightSearched)
    );
    // Return block ranges for blocks after _pendingBlockRanges and up to widestBlockRanges.
    // If a chain is disabled or doesn't have a spoke pool client, return a range of 0
    function getBlockRangeDelta(_pendingBlockRanges: number[][]): number[][] {
      return widestBundleBlockRanges.map((blockRange, index) => {
        // If pending block range doesn't have an entry for the widest range, which is possible when a new chain
        // is added to the CHAIN_ID_INDICES list, then simply set the initial block range to the widest block range.
        // This will produce a block range delta of 0 where the returned range for this chain is [widest[1], widest[1]].
        const initialBlockRange = _pendingBlockRanges[index] ?? blockRange;
        // If chain is disabled, return disabled range
        if (initialBlockRange[0] === initialBlockRange[1]) {
          return initialBlockRange;
        }
        // If pending bundle end block exceeds widest end block or if widest end block is undefined
        // (which is possible if the spoke pool client for the chain is not defined), return an empty range since there are no
        // "new" events to consider for this chain.
        if (!isDefined(blockRange[1]) || initialBlockRange[1] >= blockRange[1]) {
          return [initialBlockRange[1], initialBlockRange[1]];
        }
        // If initialBlockRange][0] > widestBlockRange[0], then we'll ignore any blocks
        // between initialBlockRange[0] and widestBlockRange[0] (inclusive) for simplicity reasons. In practice
        // this should not happen.
        return [initialBlockRange[1] + 1, blockRange[1]];
      });
    }

    // If there is a pending bundle that has not been fully executed, then it should have arweave
    // data so we can load it from there.
    if (hubPoolClient.hasPendingProposal()) {
      const pendingBundleBlockRanges = getImpliedBundleBlockRanges(
        hubPoolClient,
        this.clients.configStoreClient,
        hubPoolClient.getLatestProposedRootBundle()
      );
      // Similar to getAppoximateRefundsForBlockRange, we'll skip the full bundle reconstruction if the arweave
      // data is undefined and use the much faster approximation method which doesn't consider LP fees which is
      // ok for this use case.
      const arweaveData = await this.loadArweaveData(pendingBundleBlockRanges);
      if (!isDefined(arweaveData)) {
        combinedRefunds.push(await this.getApproximateRefundsForBlockRange(chainIds, pendingBundleBlockRanges));
      } else {
        const { bundleFillsV3, expiredDepositsToRefundV3 } = arweaveData;
        combinedRefunds.push(getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3));
      }

      // Shorten the widestBundleBlockRanges now to not double count the pending bundle blocks.
      widestBundleBlockRanges = getBlockRangeDelta(pendingBundleBlockRanges);
    }

    // Next, load all refunds sent after the last bundle proposal. This can be expensive so we'll skip the full
    // bundle reconstruction and make some simplifying assumptions:
    // - Only look up fills sent after the pending bundle's end blocks
    // - Skip LP fee computations and just assume the relayer is being refunded the full deposit.inputAmount
    const start = performance.now();
    combinedRefunds.push(await this.getApproximateRefundsForBlockRange(chainIds, widestBundleBlockRanges));
    this.logger.debug({
      at: "BundleDataClient#getNextBundleRefunds",
      message: `Loading approximate refunds for next bundle in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRanges: JSON.stringify(widestBundleBlockRanges),
    });
    return combinedRefunds;
  }

  // @dev This helper function should probably be moved to the InventoryClient
  getExecutedRefunds(
    spokePoolClient: SpokePoolClient,
    relayerRefundRoot: string
  ): {
    [tokenAddress: string]: {
      [relayer: string]: BigNumber;
    };
  } {
    if (!isDefined(spokePoolClient)) {
      return {};
    }
    // @dev Search from right to left since there can be multiple root bundles with the same relayer refund root.
    // The caller should take caution if they're trying to use this function to find matching refunds for older
    // root bundles as opposed to more recent ones.
    const bundle = _.findLast(
      spokePoolClient.getRootBundleRelays(),
      (bundle) => bundle.relayerRefundRoot === relayerRefundRoot
    );
    if (bundle === undefined) {
      return {};
    }

    const executedRefundLeaves = spokePoolClient
      .getRelayerRefundExecutions()
      .filter((leaf) => leaf.rootBundleId === bundle.rootBundleId);
    const executedRefunds: { [tokenAddress: string]: { [relayer: string]: BigNumber } } = {};
    for (const refundLeaf of executedRefundLeaves) {
      const tokenAddress = refundLeaf.l2TokenAddress.toBytes32();
      const executedTokenRefunds = (executedRefunds[tokenAddress] ??= {});

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i].toBytes32();
        const refundAmount = refundLeaf.refundAmounts[i];

        executedTokenRefunds[relayer] ??= bnZero;
        executedTokenRefunds[relayer] = executedTokenRefunds[relayer].add(refundAmount);
      }
    }
    return executedRefunds;
  }

  // @dev This helper function should probably be moved to the InventoryClient
  private deductExecutedRefunds(
    allRefunds: CombinedRefunds,
    bundleContainingRefunds: ProposedRootBundle
  ): CombinedRefunds {
    for (const chainIdStr of Object.keys(allRefunds)) {
      const chainId = Number(chainIdStr);
      const spokePoolClient = this.spokePoolClientManager.getClient(chainId);
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      const executedRefunds = this.getExecutedRefunds(spokePoolClient, bundleContainingRefunds.relayerRefundRoot);

      for (const tokenAddress of Object.keys(allRefunds[chainId])) {
        const refunds = allRefunds[chainId][tokenAddress];
        if (executedRefunds[tokenAddress] === undefined || refunds === undefined) {
          continue;
        }

        for (const relayer of Object.keys(refunds)) {
          const executedAmount = executedRefunds[tokenAddress][relayer];
          if (executedAmount === undefined) {
            continue;
          }
          // Since there should only be a single executed relayer refund leaf for each relayer-token-chain combination,
          // we can deduct this refund and mark it as executed if the executed amount is > 0.
          refunds[relayer] = bnZero;
        }
      }
    }
    return allRefunds;
  }

  getRefundsFor(bundleRefunds: CombinedRefunds, relayer: Address, chainId: number, token: Address): BigNumber {
    if (!bundleRefunds[chainId] || !bundleRefunds[chainId][token.toBytes32()]) {
      return BigNumber.from(0);
    }
    const allRefunds = bundleRefunds[chainId][token.toBytes32()];
    return allRefunds && allRefunds[relayer.toBytes32()] ? allRefunds[relayer.toBytes32()] : BigNumber.from(0);
  }

  getTotalRefund(refunds: CombinedRefunds[], relayer: Address, chainId: number, refundToken: Address): BigNumber {
    return refunds.reduce((totalRefund, refunds) => {
      return totalRefund.add(this.getRefundsFor(refunds, relayer, chainId, refundToken));
    }, bnZero);
  }

  private async loadArweaveData(blockRangesForChains: number[][]): Promise<LoadDataReturnValue> {
    const arweaveKey = this.getArweaveBundleDataClientKey(blockRangesForChains);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (!this.arweaveDataCache[arweaveKey]) {
      this.arweaveDataCache[arweaveKey] = this.loadPersistedDataFromArweave(blockRangesForChains);
    }
    const arweaveData = _.cloneDeep(await this.arweaveDataCache[arweaveKey]);
    return arweaveData!;
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  async loadData(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    attemptArweaveLoad = false
  ): Promise<LoadDataReturnValue> {
    const key = JSON.stringify(blockRangesForChains);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (!this.loadDataCache[key]) {
      let arweaveData;
      if (attemptArweaveLoad) {
        arweaveData = await this.loadArweaveData(blockRangesForChains);
      } else {
        arweaveData = undefined;
      }
      const data = isDefined(arweaveData)
        ? // We can return the data to a Promise to keep the return type consistent.
          // Note: this is now a fast operation since we've already loaded the data from Arweave.
          Promise.resolve(arweaveData)
        : this.loadDataFromScratch(blockRangesForChains, spokePoolClients);
      this.loadDataCache[key] = data;
    }

    return this.loadDataFromCache(key);
  }

  private async loadDataFromScratch(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<LoadDataReturnValue> {
    let start = performance.now();
    const key = JSON.stringify(blockRangesForChains);

    if (!this.clients.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    } else if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(blockRangesForChains[0][0]);
    const bundleEndBlockForMainnet = blockRangesForChains[0][1];

    if (blockRangesForChains.length > chainIds.length) {
      throw new Error(
        `Unexpected block range list length of ${blockRangesForChains.length}, should be <= ${chainIds.length}`
      );
    }

    // V3 specific objects:
    const bundleDepositsV3: BundleDepositsV3 = {}; // Deposits in bundle block range.
    const bundleFillsV3: BundleFillsV3 = {}; // Fills to refund in bundle block range.
    const bundleInvalidFillsV3: V3FillWithBlock[] = []; // Fills that are not valid in this bundle.
    const bundleUnrepayableFillsV3: V3FillWithBlock[] = []; // Fills that are not repayable in this bundle.
    const bundleInvalidSlowFillRequests: SlowFillRequestWithBlock[] = []; // Slow fill requests that are not valid in this bundle.
    const bundleSlowFillsV3: BundleSlowFills = {}; // Deposits that we need to send slow fills
    // for in this bundle.
    const expiredDepositsToRefundV3: ExpiredDepositsToRefundV3 = {};
    // Newly expired deposits in this bundle that need to be refunded.
    const unexecutableSlowFills: BundleExcessSlowFills = {};
    // Deposit data for all Slowfills that was included in a previous
    // bundle and can no longer be executed because (1) they were replaced with a FastFill in this bundle or
    // (2) the fill deadline has passed. We'll need to decrement running balances for these deposits on the
    // destination chain where the slow fill would have been executed.

    const _isChainDisabled = (chainId: number): boolean => {
      const blockRangeForChain = getBlockRangeForChain(blockRangesForChains, chainId, chainIds);
      return isChainDisabled(blockRangeForChain);
    };

    const _canCreateSlowFillLeaf = (deposit: DepositWithBlock): boolean => {
      return (
        // Cannot slow fill when input and output tokens are not equivalent.
        this.clients.hubPoolClient.areTokensEquivalent(
          deposit.inputToken,
          deposit.originChainId,
          deposit.outputToken,
          deposit.destinationChainId,
          bundleEndBlockForMainnet
        ) &&
        // Cannot slow fill from or to a lite chain.
        !deposit.fromLiteChain &&
        !deposit.toLiteChain
      );
    };

    const _depositIsExpired = (deposit: DepositWithBlock): boolean => {
      return deposit.fillDeadline < bundleBlockTimestamps[deposit.destinationChainId][1];
    };

    const _getFillStatusForDeposit = (deposit: Deposit, queryBlock: number): Promise<FillStatus> => {
      return spokePoolClients[deposit.destinationChainId].relayFillStatus(
        deposit,
        // We can assume that in production
        // the block to query is not one that the spoke pool client
        // hasn't queried. This is because this function will usually be called
        // in production with block ranges that were validated by
        // DataworkerUtils.blockRangesAreInvalidForSpokeClients.
        Math.min(queryBlock, spokePoolClients[deposit.destinationChainId].latestHeightSearched)
      );
    };

    // Infer chain ID's to load from number of block ranges passed in.
    const allChainIds = blockRangesForChains
      .map((_blockRange, index) => chainIds[index])
      .filter((chainId) => !_isChainDisabled(chainId) && spokePoolClients[chainId] !== undefined);
    allChainIds.forEach((chainId) => {
      const spokePoolClient = spokePoolClients[chainId];
      if (!spokePoolClient.isUpdated) {
        throw new Error(`SpokePoolClient for chain ${chainId} not updated.`);
      }
    });

    // If spoke pools are V3 contracts, then we need to compute start and end timestamps for block ranges to
    // determine whether fillDeadlines have expired.
    // @dev Going to leave this in so we can see impact on run-time in prod. This makes (allChainIds.length * 2) RPC
    // calls in parallel.
    const _cachedBundleTimestamps = this.getBundleTimestampsFromCache(key);
    let bundleBlockTimestamps: { [chainId: string]: number[] } = {};
    if (!_cachedBundleTimestamps) {
      bundleBlockTimestamps = await this.getBundleBlockTimestamps(chainIds, blockRangesForChains, spokePoolClients);
      this.setBundleTimestampsInCache(key, bundleBlockTimestamps);
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Bundle block timestamps",
        bundleBlockTimestamps,
        blockRangesForChains: JSON.stringify(blockRangesForChains),
      });
    } else {
      bundleBlockTimestamps = _cachedBundleTimestamps;
    }

    // Use this dictionary to conveniently unite all events with the same relay data hash which will make
    // secondary lookups faster. The goal is to lazily fill up this dictionary with all events in the SpokePool
    // client's in-memory event cache.
    const v3RelayHashes: {
      [relayHash: string]: {
        // Note: Since there are no partial fills in v3, there should only be one fill per relay hash.
        // Moreover, the SpokePool blocks multiple slow fill requests, so
        // there should also only be one slow fill request per relay hash.
        deposits?: V3DepositWithBlock[];
        fill?: V3FillWithBlock;
        slowFillRequest?: SlowFillRequestWithBlock;
      };
    } = {};

    // Process all deposits first and populate the v3RelayHashes dictionary. Sort deposits into whether they are
    // in this bundle block range or in a previous bundle block range.
    const bundleDepositHashes: string[] = [];
    const olderDepositHashes: string[] = [];

    const decodeBundleDepositHash = (depositHash: string): { relayDataHash: string; index: number } => {
      const [relayDataHash, i] = depositHash.split("@");
      return { relayDataHash, index: Number(i) };
    };

    // Prerequisite step: Load all deposit events from the current or older bundles into the v3RelayHashes dictionary
    // for convenient matching with fills.
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      const originChainBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);

      for (const destinationChainId of allChainIds) {
        originClient.getDepositsForDestinationChainWithDuplicates(destinationChainId).forEach((deposit) => {
          if (deposit.blockNumber > originChainBlockRange[1] || isZeroValueDeposit(deposit)) {
            return;
          }
          const relayDataHash = getRelayEventKey(deposit);

          if (!v3RelayHashes[relayDataHash]) {
            v3RelayHashes[relayDataHash] = {
              deposits: [deposit],
              fill: undefined,
              slowFillRequest: undefined,
            };
          } else {
            const { deposits } = v3RelayHashes[relayDataHash];
            assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
            deposits.push(deposit);
          }

          // Account for duplicate deposits by concatenating the relayDataHash with the count of the number of times
          // we have seen it so far.
          const { deposits } = v3RelayHashes[relayDataHash];
          assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
          const newBundleDepositHash = `${relayDataHash}@${deposits.length - 1}`;
          const decodedBundleDepositHash = decodeBundleDepositHash(newBundleDepositHash);
          assert(
            decodedBundleDepositHash.relayDataHash === relayDataHash &&
              decodedBundleDepositHash.index === deposits.length - 1,
            "Not using correct bundle deposit hash key"
          );
          if (deposit.blockNumber >= originChainBlockRange[0]) {
            if (
              bundleDepositsV3?.[originChainId]?.[deposit.inputToken.toBytes32()]?.find((d) =>
                duplicateEvent(deposit, d)
              )
            ) {
              this.logger.debug({
                at: "BundleDataClient#loadData",
                message: "Duplicate deposit detected",
                deposit: convertRelayDataParamsToBytes32(deposit),
              });
              throw new Error("Duplicate deposit detected");
            }
            bundleDepositHashes.push(newBundleDepositHash);
            updateBundleDepositsV3(bundleDepositsV3, deposit);
          } else if (deposit.blockNumber < originChainBlockRange[0]) {
            olderDepositHashes.push(newBundleDepositHash);
          }
        });
      }
    }
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Processed ${bundleDepositHashes.length + olderDepositHashes.length} deposits in ${
        performance.now() - start
      }ms.`,
    });
    start = performance.now();

    // Process fills and maintain the following the invariants:
    // - Every single fill whose type is not SlowFill in the bundle block range whose relay data matches
    // with a deposit in the same or an older range produces a refund to the filler,
    // unless the specified filler address cannot be repaid on the repayment chain.
    // - Fills can match with duplicate deposits, so for every matched fill whose type is not SlowFill
    // in the bundle block range, produce a refund to the filler for each matched deposit.
    // - For every SlowFill in the block range that matches with multiple deposits, produce a refund to the depositor
    // for every deposit except except the first.

    // Assumptions about fills:
    // - Duplicate fills for the same relay data hash are impossible to send.
    // - Fills can only be sent before the deposit's fillDeadline.
    const validatedBundleV3Fills: (V3FillWithBlock & { quoteTimestamp: number })[] = [];
    const validatedBundleSlowFills: V3DepositWithBlock[] = [];
    const validatedBundleUnexecutableSlowFills: V3DepositWithBlock[] = [];
    let fillCounter = 0;
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      for (const destinationChainId of allChainIds) {
        const destinationClient = spokePoolClients[destinationChainId];
        const destinationChainBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);
        const originChainBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);

        const fastFillsReplacingSlowFills: string[] = [];
        await forEachAsync(
          destinationClient
            .getFillsForOriginChain(originChainId)
            // We can remove fills for deposits with input amount equal to zero because these will result in 0 refunded
            // tokens to the filler. We can't remove non-empty message deposit here in case there is a slow fill
            // request for the deposit, we'd want to see the fill took place.
            .filter(
              (fill) =>
                fill.blockNumber <= destinationChainBlockRange[1] &&
                !isZeroValueFillOrSlowFillRequest(fill) &&
                !invalidOutputToken(fill)
            ),
          async (fill) => {
            fillCounter++;
            const relayDataHash = getRelayEventKey(fill);
            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].fill) {
                const { deposits } = v3RelayHashes[relayDataHash];
                assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
                v3RelayHashes[relayDataHash].fill = fill;
                if (fill.blockNumber >= destinationChainBlockRange[0]) {
                  let provider;
                  if (isEVMSpokePoolClient(destinationClient)) {
                    provider = destinationClient.spokePool.provider;
                  } else if (isSVMSpokePoolClient(destinationClient)) {
                    provider = destinationClient.svmEventsClient.getRpc();
                  }
                  const fillToRefund = await verifyFillRepayment(
                    fill,
                    provider!,
                    deposits[0],
                    this.clients.hubPoolClient,
                    bundleEndBlockForMainnet
                  );

                  if (!isDefined(fillToRefund)) {
                    bundleUnrepayableFillsV3.push(fill);
                    // We don't return here yet because we still need to mark unexecutable slow fill leaves
                    // or duplicate deposits. However, we won't issue a fast fill refund.
                  } else {
                    v3RelayHashes[relayDataHash].fill = fillToRefund;
                    validatedBundleV3Fills.push({
                      ...fillToRefund,
                      quoteTimestamp: deposits[0].quoteTimestamp,
                    });

                    // Now that we know this deposit has been filled on-chain, identify any duplicate deposits
                    // sent for this fill and refund them to the filler, because this value would not be paid out
                    // otherwise. These deposits can no longer expire and get refunded as an expired deposit,
                    // and they won't trigger a pre-fill refund because the fill is in this bundle.
                    // Pre-fill refunds only happen when deposits are sent in this bundle and the
                    // fill is from a prior bundle. Paying out the filler keeps the behavior consistent for how
                    // we deal with duplicate deposits regardless if the deposit is matched with a pre-fill or
                    // a current bundle fill.
                    const duplicateDeposits = deposits.slice(1);
                    duplicateDeposits.forEach((duplicateDeposit) => {
                      if (isSlowFill(fill)) {
                        updateExpiredDepositsV3(expiredDepositsToRefundV3, duplicateDeposit);
                      } else {
                        validatedBundleV3Fills.push({
                          ...fillToRefund,
                          quoteTimestamp: duplicateDeposit.quoteTimestamp,
                        });
                      }
                    });
                  }

                  // If fill replaced a slow fill request, then mark it as one that might have created an
                  // unexecutable slow fill. We can't know for sure until we check the slow fill request
                  // events.
                  if (
                    fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill &&
                    _canCreateSlowFillLeaf(deposits[0])
                  ) {
                    fastFillsReplacingSlowFills.push(relayDataHash);
                  }
                }
              } else {
                this.logger.debug({
                  at: "BundleDataClient#loadData",
                  message: "Duplicate fill detected",
                  fill: convertFillParamsToBytes32(fill),
                });
                throw new Error("Duplicate fill detected");
              }
              return;
            }

            // At this point, there is no relay hash dictionary entry for this fill, so we need to
            // instantiate the entry. We won't modify the fill.relayer until we match it with a deposit.
            v3RelayHashes[relayDataHash] = {
              deposits: undefined,
              fill,
              slowFillRequest: undefined,
            };

            // TODO: We can remove the following historical query once we deprecate the deposit()
            // function since there won't be any old, unexpired deposits anymore assuming the spoke pool client
            // lookbacks have been validated, which they should be before we run this function.

            // Since there was no deposit matching the relay hash, we need to do a historical query for an
            // older deposit in case the spoke pool client's lookback isn't old enough to find the matching deposit.
            // We can skip this step if the fill's fill deadline is not infinite, because we can assume that the
            // spoke pool clients have loaded deposits old enough to cover all fills with a non-infinite fill deadline.
            if (fill.blockNumber >= destinationChainBlockRange[0]) {
              // Fill has a non-infinite expiry, and we can assume our spoke pool clients have old enough deposits
              // to conclude that this fill is invalid if we haven't found a matching deposit in memory, so
              // skip the historical query.
              if (!INFINITE_FILL_DEADLINE.eq(fill.fillDeadline)) {
                bundleInvalidFillsV3.push(fill);
                return;
              }
              // If deposit is using the deterministic relay hash feature, then the following binary search-based
              // algorithm will not work. However, it is impossible to emit an infinite fill deadline using
              // the unsafeDepositV3 function so there is no need to catch the special case.
              const historicalDeposit = await queryHistoricalDepositForFill(originClient, fill);
              if (!historicalDeposit.found) {
                bundleInvalidFillsV3.push(fill);
              } else {
                const matchedDeposit = historicalDeposit.deposit;
                // If deposit is in a following bundle, then this fill will have to be refunded once that deposit
                // is in the current bundle.
                if (matchedDeposit.blockNumber > originChainBlockRange[1]) {
                  bundleInvalidFillsV3.push(fill);
                  return;
                }
                v3RelayHashes[relayDataHash].deposits = [matchedDeposit];

                let provider;
                if (isEVMSpokePoolClient(destinationClient)) {
                  provider = destinationClient.spokePool.provider;
                } else if (isSVMSpokePoolClient(destinationClient)) {
                  provider = destinationClient.svmEventsClient.getRpc();
                }

                const fillToRefund = await verifyFillRepayment(
                  fill,
                  provider!,
                  matchedDeposit,
                  this.clients.hubPoolClient,
                  bundleEndBlockForMainnet
                );
                if (!isDefined(fillToRefund)) {
                  bundleUnrepayableFillsV3.push(fill);
                  // Don't return yet as we still need to mark down any unexecutable slow fill leaves
                  // in case this fast fill replaced a slow fill request.
                } else {
                  // @dev Since queryHistoricalDepositForFill validates the fill by checking individual
                  // object property values against the deposit's, we
                  // sanity check it here by comparing the full relay hashes. If there's an error here then the
                  // historical deposit query is not working as expected.
                  assert(getRelayEventKey(matchedDeposit) === relayDataHash, "Relay hashes should match.");
                  validatedBundleV3Fills.push({
                    ...fillToRefund,
                    quoteTimestamp: matchedDeposit.quoteTimestamp,
                  });
                  v3RelayHashes[relayDataHash].fill = fillToRefund;

                  // No need to check for duplicate deposits here since duplicate deposits with
                  // infinite deadlines are impossible to send via unsafeDeposit().
                }

                if (
                  fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill &&
                  _canCreateSlowFillLeaf(matchedDeposit)
                ) {
                  fastFillsReplacingSlowFills.push(relayDataHash);
                }
              }
            }
          }
        );

        // Process slow fill requests and produce slow fill leaves while maintaining the following the invariants:
        // - Slow fill leaves cannot be produced for deposits that have expired in this bundle.
        // - Slow fill leaves cannot be produced for deposits that have been filled.

        // Assumptions about fills:
        // - Duplicate slow fill requests for the same relay data hash are impossible to send.
        // - Slow fill requests can only be sent before the deposit's fillDeadline.
        // - Slow fill requests for a deposit that has been filled.
        await forEachAsync(
          destinationClient
            .getSlowFillRequestsForOriginChain(originChainId)
            .filter(
              (request) =>
                request.blockNumber <= destinationChainBlockRange[1] &&
                !isZeroValueFillOrSlowFillRequest(request) &&
                !invalidOutputToken(request)
            ),
          async (slowFillRequest: SlowFillRequestWithBlock) => {
            const relayDataHash = getRelayEventKey(slowFillRequest);

            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].slowFillRequest) {
                v3RelayHashes[relayDataHash].slowFillRequest = slowFillRequest;
                const { deposits, fill } = v3RelayHashes[relayDataHash];
                if (fill) {
                  // Exiting here assumes that slow fill requests must precede fills, so if there was a fill
                  // following this slow fill request, then we would have already seen it. We don't need to check
                  // for a fill older than this slow fill request.
                  return;
                }
                assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
                const matchedDeposit = deposits[0];

                if (
                  slowFillRequest.blockNumber >= destinationChainBlockRange[0] &&
                  _canCreateSlowFillLeaf(matchedDeposit) &&
                  !_depositIsExpired(matchedDeposit)
                ) {
                  validatedBundleSlowFills.push(matchedDeposit);
                }
              } else {
                this.logger.debug({
                  at: "BundleDataClient#loadData",
                  message: "Duplicate slow fill request detected",
                  slowFillRequest,
                });
                throw new Error("Duplicate slow fill request detected.");
              }
              return;
            }

            // Instantiate dictionary if there is neither a deposit nor fill matching it.
            v3RelayHashes[relayDataHash] = {
              deposits: undefined,
              fill: undefined,
              slowFillRequest: slowFillRequest,
            };

            // TODO: We can remove the following historical query once we deprecate the deposit()
            // function since there won't be any old, unexpired deposits anymore assuming the spoke pool client
            // lookbacks have been validated, which they should be before we run this function.

            // Since there was no deposit matching the relay hash, we need to do a historical query for an
            // older deposit in case the spoke pool client's lookback isn't old enough to find the matching deposit.
            // We can skip this step if the deposit's fill deadline is not infinite, because we can assume that the
            // spoke pool clients have loaded deposits old enough to cover all fills with a non-infinite fill deadline.
            // We do not need to handle the case where the deposit ID is > uint32 (in which case we wouldn't
            // want to perform a binary search lookup for it because the deposit ID is "unsafe" and cannot be
            // found using such a method) because infinite fill deadlines cannot be produced from the unsafeDepositV3()
            // function.
            if (slowFillRequest.blockNumber >= destinationChainBlockRange[0]) {
              if (!INFINITE_FILL_DEADLINE.eq(slowFillRequest.fillDeadline)) {
                bundleInvalidSlowFillRequests.push(slowFillRequest);
                return;
              }
              const historicalDeposit = await queryHistoricalDepositForFill(originClient, slowFillRequest);
              if (!historicalDeposit.found) {
                bundleInvalidSlowFillRequests.push(slowFillRequest);
                return;
              }
              const matchedDeposit: V3DepositWithBlock = historicalDeposit.deposit;
              // If deposit is in a following bundle, then this slow fill request will have to be created
              // once that deposit is in the current bundle.
              if (matchedDeposit.blockNumber > originChainBlockRange[1]) {
                bundleInvalidSlowFillRequests.push(slowFillRequest);
                return;
              }
              // @dev Since queryHistoricalDepositForFill validates the slow fill request by checking individual
              // object property values against the deposit's, we
              // sanity check it here by comparing the full relay hashes. If there's an error here then the
              // historical deposit query is not working as expected.
              assert(getRelayEventKey(matchedDeposit) === relayDataHash, "Deposit relay hashes should match.");
              v3RelayHashes[relayDataHash].deposits = [matchedDeposit];

              if (!_canCreateSlowFillLeaf(matchedDeposit) || _depositIsExpired(matchedDeposit)) {
                return;
              }
              validatedBundleSlowFills.push(matchedDeposit);
            }
          }
        );

        // Process deposits and maintain the following invariants:
        // - Deposits matching fills that are not type SlowFill from previous bundle block ranges should produce
        // refunds for those fills.
        // - Deposits matching fills that are type SlowFill from previous bundle block ranges should be refunded to the
        // depositor.
        // - All deposits expiring in this bundle, even those sent in prior bundle block ranges, should be refunded
        // to the depositor.
        // - An expired deposit cannot be refunded if the deposit was filled.
        // - If a deposit from a prior bundle expired in this bundle, had a slow fill request created for it
        // in a prior bundle, and has not been filled yet, then an unexecutable slow fill leaf has been created
        // and needs to be refunded to the HubPool.
        // - Deposits matching slow fill requests from previous bundle block ranges should produce slow fills
        // if the deposit has not been filled.

        // Assumptions:
        // - If the deposit has a matching fill or slow fill request in the bundle then we have already stored
        // it in the relay hashes dictionary.
        // - We've created refunds for all fills in this bundle matching a deposit.
        // - We've created slow fill leaves for all slow fill requests in this bundle matching an unfilled deposit.
        // - Deposits for the same relay data hash can be sent an arbitrary amount of times.
        // - Deposits can be sent an arbitrary amount of time after a fill has been sent for the matching relay data.
        await mapAsync(bundleDepositHashes, async (depositHash) => {
          const { relayDataHash, index } = decodeBundleDepositHash(depositHash);
          const { deposits, fill, slowFillRequest } = v3RelayHashes[relayDataHash];
          if (!deposits || deposits.length === 0) {
            throw new Error("Deposits should exist in relay hash dictionary.");
          }
          const deposit = deposits[index];
          if (!deposit) throw new Error("Deposit should exist in relay hash dictionary.");
          if (deposit.originChainId !== originChainId || deposit.destinationChainId !== destinationChainId) {
            return;
          }

          // If fill is in the current bundle then we can assume there is already a refund for it, so only
          // include this pre fill if the fill is in an older bundle.
          if (fill) {
            if (fill.blockNumber < destinationChainBlockRange[0]) {
              let provider;
              if (isEVMSpokePoolClient(destinationClient)) {
                provider = destinationClient.spokePool.provider;
              } else if (isSVMSpokePoolClient(destinationClient)) {
                provider = destinationClient.svmEventsClient.getRpc();
              }
              const fillToRefund = await verifyFillRepayment(
                fill,
                provider!,
                deposits[0],
                this.clients.hubPoolClient,
                bundleEndBlockForMainnet
              );
              if (!isDefined(fillToRefund)) {
                bundleUnrepayableFillsV3.push(fill);
              } else if (!isSlowFill(fill)) {
                v3RelayHashes[relayDataHash].fill = fillToRefund;
                validatedBundleV3Fills.push({
                  ...fillToRefund,
                  quoteTimestamp: deposit.quoteTimestamp,
                });
              } else {
                updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
              }
            }
            return;
          }

          // If a slow fill request exists in memory, then we know the deposit has not been filled because fills
          // must follow slow fill requests and we would have seen the fill already if it existed.,
          // We can conclude that either the deposit has expired or we need to create a slow fill leaf for the
          // deposit because it has not been filled. Slow fill leaves were already created for requests sent
          // in the current bundle so only create new slow fill leaves for prior bundle deposits.
          if (slowFillRequest) {
            if (_depositIsExpired(deposit)) {
              updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
            } else if (
              slowFillRequest.blockNumber < destinationChainBlockRange[0] &&
              _canCreateSlowFillLeaf(deposit) &&
              validatedBundleSlowFills.every((d) => getRelayEventKey(d) !== relayDataHash)
            ) {
              validatedBundleSlowFills.push(deposit);
            }
            return;
          }

          // So at this point in the code, there is no fill or slow fill request in memory for this deposit.
          // We need to check its fill status on-chain to figure out whether to issue a refund or a slow fill leaf.
          // We can assume at this point that all fills or slow fill requests, if found, were in previous bundles
          // because the spoke pool client lookback would have returned this entire bundle of events and stored
          // them into the relay hash dictionary.
          const fillStatus = await _getFillStatusForDeposit(deposit, destinationChainBlockRange[1]);
          if (fillStatus === FillStatus.Filled) {
            // We don't need to verify the fill block is before the bundle end block on the destination chain because
            // we queried the fillStatus at the end block. Therefore, if the fill took place after the end block,
            // then we wouldn't be in this branch of the code.
            const prefill = await this.findMatchingFillEvent(deposit, destinationClient);
            assert(isDefined(prefill), `findFillEvent# Cannot find prefill: ${relayDataHash}`);
            assert(getRelayEventKey(prefill) === relayDataHash, "Relay hashes should match.");
            let provider;
            if (isEVMSpokePoolClient(destinationClient)) {
              provider = destinationClient.spokePool.provider;
            } else if (isSVMSpokePoolClient(destinationClient)) {
              provider = destinationClient.svmEventsClient.getRpc();
            }
            const verifiedFill = await verifyFillRepayment(
              prefill,
              provider!,
              deposit,
              this.clients.hubPoolClient,
              bundleEndBlockForMainnet
            );
            if (!isDefined(verifiedFill)) {
              bundleUnrepayableFillsV3.push(prefill);
            } else if (!isSlowFill(verifiedFill)) {
              validatedBundleV3Fills.push({
                ...verifiedFill,
                quoteTimestamp: deposit.quoteTimestamp,
              });
            } else {
              updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
            }
          } else if (_depositIsExpired(deposit)) {
            updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
          } else if (
            fillStatus === FillStatus.RequestedSlowFill &&
            // Don't create duplicate slow fill requests for the same deposit.
            validatedBundleSlowFills.every((d) => getRelayEventKey(d) !== relayDataHash)
          ) {
            if (_canCreateSlowFillLeaf(deposit)) {
              validatedBundleSlowFills.push(deposit);
            }
          }
        });

        // For all fills that came after a slow fill request, we can now check if the slow fill request
        // was a valid one and whether it was created in a previous bundle. If so, then it created a slow fill
        // leaf that is now unexecutable.
        fastFillsReplacingSlowFills.forEach((relayDataHash) => {
          const { deposits, slowFillRequest, fill } = v3RelayHashes[relayDataHash];
          assert(
            fill?.relayExecutionInfo.fillType === FillType.ReplacedSlowFill,
            "Fill type should be ReplacedSlowFill."
          );
          // Needed for TSC - are implicitely checking that deposit exists by making it to this point.
          if (!deposits || deposits.length < 1) {
            throw new Error("Deposit should exist in relay hash dictionary.");
          }
          // We should never push fast fills involving lite chains here because slow fill requests for them are invalid:
          assert(
            _canCreateSlowFillLeaf(deposits[0]),
            "fastFillsReplacingSlowFills should contain only deposits that can be slow filled"
          );
          const destinationBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);
          const originBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);
          const matchedDeposit = deposits[0];
          // For a slow fill leaf to have been created (and subsequently create an excess), the deposit matching the
          // slow fill request must have been included in a previous bundle AND the slow fill request should not
          // be included in this bundle. This is because a slow fill request is only valid once its deposit
          // has been mined, so if the deposit is not in a prior bundle to the fill, then no slow fill leaf could
          // have been created. Secondly, the slow fill request itself must have occurred in an older bundle than the
          // fill otherwise the slow fill leaf be unexecutable for an already-filled deposit..
          if (
            matchedDeposit.blockNumber < originBlockRange[0] &&
            // If there is a slow fill request in this bundle that matches the relay hash, then there was no slow fill
            // created that would be considered excess.
            (!slowFillRequest || slowFillRequest.blockNumber < destinationBlockRange[0])
          ) {
            validatedBundleUnexecutableSlowFills.push(deposits[0]);
          }
        });
      }
    }
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Processed ${fillCounter} fills in ${performance.now() - start}ms.`,
    });
    start = performance.now();

    // For all deposits older than this bundle, we need to check if they expired in this bundle and if they did,
    // whether there was a slow fill created for it in a previous bundle that is now unexecutable and replaced
    // by a new expired deposit refund.
    await forEachAsync(olderDepositHashes, async (depositHash) => {
      const { relayDataHash, index } = decodeBundleDepositHash(depositHash);
      const { deposits, slowFillRequest, fill } = v3RelayHashes[relayDataHash];
      if (!deposits || deposits.length < 1) {
        throw new Error("Deposit should exist in relay hash dictionary.");
      }
      const deposit = deposits[index];
      const { destinationChainId } = deposit;
      const destinationBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);

      // Only look for deposits that were mined before this bundle and that are newly expired.
      // If the fill deadline is lower than the bundle start block on the destination chain, then
      // we should assume it was refunded in a previous bundle.
      if (
        // If there is a valid fill that we saw matching this deposit, then it does not need a refund.
        !fill &&
        isDefined(deposit) && // Needed for TSC - we check this above.
        _depositIsExpired(deposit) &&
        deposit.fillDeadline >= bundleBlockTimestamps[destinationChainId][0] &&
        spokePoolClients[destinationChainId] !== undefined
      ) {
        // If we haven't seen a fill matching this deposit, then we need to rule out that it was filled a long time ago
        // by checkings its on-chain fill status.
        const fillStatus = await _getFillStatusForDeposit(deposit, destinationBlockRange[1]);

        // If there is no matching fill and the deposit expired in this bundle and the fill status on-chain is not
        // Filled, then we can to refund it as an expired deposit.
        if (fillStatus !== FillStatus.Filled) {
          updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
        }
        // If fill status is RequestedSlowFill, then we might need to mark down an unexecutable
        // slow fill that we're going to replace with an expired deposit refund.
        // If deposit cannot be slow filled, then exit early.
        if (fillStatus !== FillStatus.RequestedSlowFill || !_canCreateSlowFillLeaf(deposit)) {
          return;
        }
        // Now, check if there was a slow fill created for this deposit in a previous bundle which would now be
        // unexecutable. Mark this deposit as having created an unexecutable slow fill if there is no matching
        // slow fill request or the matching slow fill request took place in a previous bundle.

        // If there is a slow fill request in this bundle, then the expired deposit refund will supercede
        // the slow fill request. If there is no slow fill request seen or its older than this bundle, then we can
        // assume a slow fill leaf was created for it when the deposit was mined. Therefore, because the deposit
        // was in an older bundle, we can assume that a slow fill leaf was created at that time and therefore
        // is now unexecutable.
        if (!slowFillRequest || slowFillRequest.blockNumber < destinationBlockRange[0]) {
          validatedBundleUnexecutableSlowFills.push(deposit);
        }
      }
    });

    // Batch compute V3 lp fees.
    start = performance.now();
    const promises = [
      validatedBundleV3Fills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleV3Fills.map((fill) => {
              const { deposits } = v3RelayHashes[getRelayEventKey(fill)];
              assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
              const matchedDeposit = deposits[0];
              assert(isDefined(matchedDeposit), "Deposit should exist in relay hash dictionary.");
              const { chainToSendRefundTo: paymentChainId } = getRefundInformationFromFill(
                {
                  ...fill,
                  fromLiteChain: matchedDeposit.fromLiteChain,
                },
                this.clients.hubPoolClient,
                bundleEndBlockForMainnet
              );
              return {
                ...fill,
                paymentChainId,
              };
            })
          )
        : [],
      validatedBundleSlowFills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleSlowFills.map((deposit) => {
              return {
                ...deposit,
                paymentChainId: deposit.destinationChainId,
              };
            })
          )
        : [],
      validatedBundleUnexecutableSlowFills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleUnexecutableSlowFills.map((deposit) => {
              return {
                ...deposit,
                paymentChainId: deposit.destinationChainId,
              };
            })
          )
        : [],
    ];
    const [v3FillLpFees, v3SlowFillLpFees, v3UnexecutableSlowFillLpFees] = await Promise.all(promises);
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Computed batch async LP fees in ${performance.now() - start}ms.`,
    });
    v3FillLpFees.forEach(({ realizedLpFeePct }, idx) => {
      const fill = validatedBundleV3Fills[idx];
      const { deposits } = v3RelayHashes[getRelayEventKey(fill)];
      assert(isDefined(deposits) && deposits.length > 0, "Deposit should exist in relay hash dictionary.");
      const associatedDeposit = deposits[0];
      assert(isDefined(associatedDeposit), "Deposit should exist in relay hash dictionary.");
      const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
        {
          ...fill,
          fromLiteChain: associatedDeposit.fromLiteChain,
        },
        this.clients.hubPoolClient,
        bundleEndBlockForMainnet
      );
      updateBundleFillsV3(bundleFillsV3, fill, realizedLpFeePct, chainToSendRefundTo, repaymentToken, fill.relayer);
    });
    v3SlowFillLpFees.forEach(({ realizedLpFeePct: lpFeePct }, idx) => {
      const deposit = validatedBundleSlowFills[idx];
      // We should not create slow fill leaves for duplicate deposit hashes and we should only create a slow
      // fill leaf for the first deposit (the quote timestamp of the deposit determines the LP fee, so its
      // important we pick out the correct deposit). Deposits are pushed into validatedBundleSlowFills in ascending
      // order so the following slice will only match the first deposit.
      const relayDataHash = getRelayEventKey(deposit);
      if (validatedBundleSlowFills.slice(0, idx).some((d) => getRelayEventKey(d) === relayDataHash)) {
        return;
      }
      assert(!_depositIsExpired(deposit), "Cannot create slow fill leaf for expired deposit.");
      updateBundleSlowFills(bundleSlowFillsV3, { ...deposit, lpFeePct });
    });
    v3UnexecutableSlowFillLpFees.forEach(({ realizedLpFeePct: lpFeePct }, idx) => {
      const deposit = validatedBundleUnexecutableSlowFills[idx];
      updateBundleExcessSlowFills(unexecutableSlowFills, { ...deposit, lpFeePct });
    });

    const v3SpokeEventsReadable = prettyPrintV3SpokePoolEvents(
      bundleDepositsV3,
      bundleFillsV3,
      bundleSlowFillsV3,
      expiredDepositsToRefundV3,
      unexecutableSlowFills
    );

    if (bundleInvalidFillsV3.length > 0) {
      // For extra clarity, check if any invalid fills match with a deposit on deposit ID and origin chain. These
      // are most likely truly invalid fills due to re-org.
      const invalidFillsWithPartialMatchedDeposits: FillWithBlock[] = [];

      // If the fill matches with a deposit following the bundle then the fill will be refunded as a pre-fill
      // in the next bundle.
      const preFillsForNextBundle: FillWithBlock[] = [];

      // These fills don't partially match with any deposit in our memory.
      const unknownReasonInvalidFills: FillWithBlock[] = [];

      bundleInvalidFillsV3.forEach((fill) => {
        const originClient = spokePoolClients[fill.originChainId];
        const fullyMatchedDeposit = originClient.getDepositForFill(fill);
        if (!isDefined(fullyMatchedDeposit)) {
          const partiallyMatchedDeposit = originClient.getDeposit(fill.depositId);
          if (isDefined(partiallyMatchedDeposit)) {
            invalidFillsWithPartialMatchedDeposits.push(fill);
          } else {
            unknownReasonInvalidFills.push(fill);
          }
        } else {
          const originBundleBlockRange = getBlockRangeForChain(blockRangesForChains, fill.originChainId, chainIds);
          if (fullyMatchedDeposit.blockNumber <= originBundleBlockRange[1]) {
            throw new Error("Detected invalid fill that matches fully with a deposit in current or prior bundle");
          }
          preFillsForNextBundle.push(fill);
        }
      });

      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some invalid fills in range",
        blockRangesForChains,
        invalidFillsWithPartialMatchedDeposits: invalidFillsWithPartialMatchedDeposits.map((invalidFill) =>
          convertFillParamsToBytes32(invalidFill)
        ),
        preFillsForNextBundle: preFillsForNextBundle.map((preFill) => convertFillParamsToBytes32(preFill)),
        unknownReasonInvalidFills: unknownReasonInvalidFills.map((invalidFill) =>
          convertFillParamsToBytes32(invalidFill)
        ),
      });
    }

    if (bundleUnrepayableFillsV3.length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some unrepayable fills in range",
        blockRangesForChains,
        bundleUnrepayableFillsV3,
      });
    }

    if (bundleInvalidSlowFillRequests.length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some invalid slow fill requests in range",
        blockRangesForChains,
        bundleInvalidSlowFillRequests,
      });
    }

    this.logger.debug({
      at: "BundleDataClient#loadDataFromScratch",
      message: `Computed bundle data in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRangesForChains: JSON.stringify(blockRangesForChains),
      v3SpokeEventsReadable,
    });
    return {
      bundleDepositsV3,
      expiredDepositsToRefundV3,
      bundleFillsV3,
      unexecutableSlowFills,
      bundleSlowFillsV3,
    };
  }

  protected async findMatchingFillEvent(
    deposit: DepositWithBlock,
    spokePoolClient: SpokePoolClient
  ): Promise<FillWithBlock | undefined> {
    if (isSVMSpokePoolClient(spokePoolClient)) {
      return await findSvmFillEvent(
        deposit,
        spokePoolClient.chainId,
        spokePoolClient.svmEventsClient,
        spokePoolClient.deploymentBlock,
        spokePoolClient.latestHeightSearched
      );
    } else if (isEVMSpokePoolClient(spokePoolClient)) {
      return await findEvmFillEvent(
        spokePoolClient.spokePool,
        deposit,
        spokePoolClient.deploymentBlock,
        spokePoolClient.latestHeightSearched
      );
    } else {
      throw new Error("Unsupported spoke pool client type");
    }
  }

  async getBundleBlockTimestamps(
    chainIds: number[],
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<{ [chainId: string]: number[] }> {
    return Object.fromEntries(
      (
        await mapAsync(chainIds, async (chainId, index) => {
          const blockRangeForChain = blockRangesForChains[index];
          if (!isDefined(blockRangeForChain) || isChainDisabled(blockRangeForChain)) {
            return;
          }
          const [_startBlockForChain, _endBlockForChain] = blockRangeForChain;
          const spokePoolClient = spokePoolClients[chainId];

          // Relayer instances using the BundleDataClient for repayment estimates may only relay on a subset of chains.
          if (!isDefined(spokePoolClient)) {
            return;
          }

          // We can assume that in production the block ranges passed into this function would never
          // contain blocks where the spoke pool client hasn't queried. This is because this function
          // will usually be called in production with block ranges that were validated by
          // DataworkerUtils.blockRangesAreInvalidForSpokeClients.
          const startBlockForChain = Math.min(_startBlockForChain, spokePoolClient.latestHeightSearched);
          // @dev Add 1 to the bundle end block. The thinking here is that there can be a gap between
          // block timestamps in subsequent blocks. The bundle data client assumes that fill deadlines expire
          // in exactly one bundle, therefore we must make sure that the bundle block timestamp for one bundle's
          // end block is exactly equal to the bundle block timestamp for the next bundle's start block. This way
          // there are no gaps in block timestamps between bundles.
          const endBlockForChain = Math.min(_endBlockForChain + 1, spokePoolClient.latestHeightSearched);
          const [startTime, _endTime] = [
            await spokePoolClient.getTimestampForBlock(startBlockForChain),
            await spokePoolClient.getTimestampForBlock(endBlockForChain),
          ];
          // @dev similar to reasoning above to ensure no gaps between bundle block range timestamps and also
          // no overlap, subtract 1 from the end time.
          const endBlockDelta = endBlockForChain > startBlockForChain ? 1 : 0;
          const endTime = Math.max(0, _endTime - endBlockDelta);

          // Sanity checks:
          assert(
            endTime >= startTime,
            `End time for block ${endBlockForChain} should be greater than start time for block ${startBlockForChain}: ${endTime} >= ${startTime}.`
          );
          assert(
            startBlockForChain === 0 || startTime > 0,
            "Start timestamp must be greater than 0 if the start block is greater than 0."
          );
          return [chainId, [startTime, endTime]];
        })
      ).filter(isDefined)
    );
  }
}
