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
import { AcrossConfigStoreClient, SpokePoolClient } from "..";
import {
  BigNumber,
  bnZero,
  queryHistoricalDepositForFill,
  assign,
  assert,
  fixedPointAdjustment,
  isDefined,
  toBN,
  forEachAsync,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  isSlowFill,
  mapAsync,
  filterAsync,
  bnUint32Max,
  isZeroValueDeposit,
  findFillEvent,
  isZeroValueFillOrSlowFillRequest,
  chainIsEvm,
  isValidEvmAddress,
} from "../../utils";
import winston from "winston";
import {
  _buildPoolRebalanceRoot,
  BundleDataSS,
  getEndBlockBuffers,
  getRefundInformationFromFill,
  getRefundsFromBundle,
  getWidestPossibleExpectedBlockRange,
  isChainDisabled,
  PoolRebalanceRoot,
  prettyPrintV3SpokePoolEvents,
  V3DepositWithBlock,
  V3FillWithBlock,
  verifyFillRepayment,
} from "./utils";
import { PRE_FILL_MIN_CONFIG_STORE_VERSION } from "../../constants";

// max(uint256) - 1
export const INFINITE_FILL_DEADLINE = bnUint32Max;

type DataCache = Record<string, Promise<LoadDataReturnValue>>;

// V3 dictionary helper functions
function updateExpiredDepositsV3(dict: ExpiredDepositsToRefundV3, deposit: V3DepositWithBlock): void {
  // A deposit refund for a deposit is invalid if the depositor has a bytes32 address input for an EVM chain. It is valid otherwise.
  if (chainIsEvm(deposit.originChainId) && !isValidEvmAddress(deposit.depositor)) {
    return;
  }
  const { originChainId, inputToken } = deposit;
  if (!dict?.[originChainId]?.[inputToken]) {
    assign(dict, [originChainId, inputToken], []);
  }
  dict[originChainId][inputToken].push(deposit);
}

function updateBundleDepositsV3(dict: BundleDepositsV3, deposit: V3DepositWithBlock): void {
  const { originChainId, inputToken } = deposit;
  if (!dict?.[originChainId]?.[inputToken]) {
    assign(dict, [originChainId, inputToken], []);
  }
  dict[originChainId][inputToken].push(deposit);
}

function updateBundleFillsV3(
  dict: BundleFillsV3,
  fill: V3FillWithBlock,
  lpFeePct: BigNumber,
  repaymentChainId: number,
  repaymentToken: string,
  repaymentAddress: string
): void {
  // It is impossible to refund a deposit if the repayment chain is EVM and the relayer is a non-evm address.
  if (chainIsEvm(repaymentChainId) && !isValidEvmAddress(repaymentAddress)) {
    return;
  }
  if (!dict?.[repaymentChainId]?.[repaymentToken]) {
    assign(dict, [repaymentChainId, repaymentToken], {
      fills: [],
      totalRefundAmount: bnZero,
      realizedLpFees: bnZero,
      refunds: {},
    });
  }

  const bundleFill: BundleFillV3 = { ...fill, lpFeePct, relayer: repaymentAddress };

  // Add all fills, slow and fast, to dictionary.
  assign(dict, [repaymentChainId, repaymentToken, "fills"], [bundleFill]);

  // All fills update the bundle LP fees.
  const refundObj = dict[repaymentChainId][repaymentToken];
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

    if (refundObj.refunds[bundleFill.relayer]) {
      refundObj.refunds[bundleFill.relayer] = refundObj.refunds[bundleFill.relayer].add(refundAmount);
    } else {
      refundObj.refunds[bundleFill.relayer] = refundAmount;
    }
  }
}

function updateBundleExcessSlowFills(
  dict: BundleExcessSlowFills,
  deposit: V3DepositWithBlock & { lpFeePct: BigNumber }
): void {
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  dict[destinationChainId][outputToken].push(deposit);
}

function updateBundleSlowFills(dict: BundleSlowFills, deposit: V3DepositWithBlock & { lpFeePct: BigNumber }): void {
  if (chainIsEvm(deposit.destinationChainId) && !isValidEvmAddress(deposit.recipient)) {
    return;
  }
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  dict[destinationChainId][outputToken].push(deposit);
}

// @notice Shared client for computing data needed to construct or validate a bundle.
export class BundleDataClient {
  private loadDataCache: DataCache = {};
  private arweaveDataCache: Record<string, Promise<LoadDataReturnValue | undefined>> = {};

  private bundleTimestampCache: Record<string, { [chainId: number]: number[] }> = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: Clients,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {}
  ) {}

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

    const data = persistedData[0].data;
    const bundleData = {
      bundleFillsV3: convertTypedStringRecordIntoNumericRecord(data.bundleFillsV3),
      expiredDepositsToRefundV3: convertTypedStringRecordIntoNumericRecord(data.expiredDepositsToRefundV3),
      bundleDepositsV3: convertTypedStringRecordIntoNumericRecord(data.bundleDepositsV3),
      unexecutableSlowFills: convertTypedStringRecordIntoNumericRecord(data.unexecutableSlowFills),
      bundleSlowFillsV3: convertTypedStringRecordIntoNumericRecord(data.bundleSlowFillsV3),
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
      this.clients.hubPoolClient.latestBlockSearched
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
      this.clients.hubPoolClient.latestBlockSearched,
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
    if (arweaveData === undefined) {
      combinedRefunds = await this.getApproximateRefundsForBlockRange(chainIds, bundleEvaluationBlockRanges);
    } else {
      const { bundleFillsV3, expiredDepositsToRefundV3 } = arweaveData;
      combinedRefunds = getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3);
      // If we don't have a spoke pool client for a chain, then we won't be able to deduct refunds correctly for this
      // chain. For most of the pending bundle's liveness period, these past refunds are already executed so this is
      // a reasonable assumption. This empty refund chain also matches what the alternative
      // `getApproximateRefundsForBlockRange` would return.
      Object.keys(combinedRefunds).forEach((chainId) => {
        if (this.spokePoolClients[Number(chainId)] === undefined) {
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
    for (const chainId of chainIds) {
      if (this.spokePoolClients[chainId] === undefined) {
        continue;
      }
      const chainIndex = chainIds.indexOf(chainId);
      // @dev This function does not account for pre-fill refunds as it is optimized for speed. The way to detect
      // pre-fill refunds is to load all deposits that are unmatched by fills in the spoke pool client's memory
      // and then query the FillStatus on-chain, but that might slow this function down too much. For now, we
      // will live with this expected inaccuracy as it should be small. The pre-fill would have to precede the deposit
      // by more than the caller's event lookback window which is expected to be unlikely.
      const fillsToCount = await filterAsync(this.spokePoolClients[chainId].getFills(), async (fill) => {
        if (
          fill.blockNumber < blockRanges[chainIndex][0] ||
          fill.blockNumber > blockRanges[chainIndex][1] ||
          isZeroValueFillOrSlowFillRequest(fill)
        ) {
          return false;
        }

        // If origin spoke pool client isn't defined, we can't validate it.
        if (this.spokePoolClients[fill.originChainId] === undefined) {
          return false;
        }
        const matchingDeposit = this.spokePoolClients[fill.originChainId].getDeposit(fill.depositId);
        const hasMatchingDeposit =
          matchingDeposit !== undefined &&
          this.getRelayHashFromEvent(fill) === this.getRelayHashFromEvent(matchingDeposit);
        if (hasMatchingDeposit) {
          const validRepayment = await verifyFillRepayment(
            fill,
            this.spokePoolClients[fill.destinationChainId].spokePool.provider,
            matchingDeposit,
            // @dev: to get valid repayment chain ID's, get all chain IDs for the bundle block range and remove
            // disabled block ranges.
            this.clients.configStoreClient
              .getChainIdIndicesForBlock(blockRanges[0][1])
              .filter((_chainId, i) => !isChainDisabled(blockRanges[i]))
          );
          if (!isDefined(validRepayment)) {
            return false;
          }
        }
        return hasMatchingDeposit;
      });
      fillsToCount.forEach((fill) => {
        const matchingDeposit = this.spokePoolClients[fill.originChainId].getDeposit(fill.depositId);
        assert(isDefined(matchingDeposit), "Deposit not found for fill.");
        const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
          fill,
          this.clients.hubPoolClient,
          blockRanges,
          this.chainIdListForBundleEvaluationBlockNumbers,
          matchingDeposit!.fromLiteChain // Use ! because we've already asserted that matchingDeposit is defined.
        );
        // Assume that lp fees are 0 for the sake of speed. In the future we could batch compute
        // these or make hardcoded assumptions based on the origin-repayment chain direction. This might result
        // in slight over estimations of refunds, but its not clear whether underestimating or overestimating is
        // worst from the relayer's perspective.
        const { relayer, inputAmount: refundAmount } = fill;
        refundsForChain[chainToSendRefundTo] ??= {};
        refundsForChain[chainToSendRefundTo][repaymentToken] ??= {};
        const existingRefundAmount = refundsForChain[chainToSendRefundTo][repaymentToken][relayer] ?? bnZero;
        refundsForChain[chainToSendRefundTo][repaymentToken][relayer] = existingRefundAmount.add(refundAmount);
      });
    }
    return refundsForChain;
  }

  getUpcomingDepositAmount(chainId: number, l2Token: string, latestBlockToSearch: number): BigNumber {
    if (this.spokePoolClients[chainId] === undefined) {
      return toBN(0);
    }
    return this.spokePoolClients[chainId]
      .getDeposits()
      .filter((deposit) => deposit.blockNumber > latestBlockToSearch && deposit.inputToken === l2Token)
      .reduce((acc, deposit) => {
        return acc.add(deposit.inputAmount);
      }, toBN(0));
  }

  private async getLatestProposedBundleData(): Promise<{ bundleData: LoadDataReturnValue; blockRanges: number[][] }> {
    const hubPoolClient = this.clients.hubPoolClient;
    // Determine which bundle we should fetch from arweave, either the pending bundle or the latest
    // executed one. Both should have arweave data but if for some reason the arweave data is missing,
    // this function will have to compute the bundle data from scratch which will be slow. We have to fallback
    // to computing the bundle from scratch since this function needs to return the full bundle data so that
    // it can be used to get the running balance proposed using its data.
    const bundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      this.clients.configStoreClient,
      hubPoolClient.hasPendingProposal()
        ? hubPoolClient.getLatestProposedRootBundle()
        : hubPoolClient.getLatestFullyExecutedRootBundle(hubPoolClient.latestBlockSearched)! // ! because we know there is a bundle
    );
    return {
      blockRanges: bundleBlockRanges,
      bundleData: await this.loadData(
        bundleBlockRanges,
        this.spokePoolClients,
        true // this bundle data should have been published to arweave
      ),
    };
  }

  async getLatestPoolRebalanceRoot(): Promise<{ root: PoolRebalanceRoot; blockRanges: number[][] }> {
    const { bundleData, blockRanges } = await this.getLatestProposedBundleData();
    const hubPoolClient = this.clients.hubPoolClient;
    const root = _buildPoolRebalanceRoot(
      hubPoolClient.latestBlockSearched,
      blockRanges[0][1],
      bundleData.bundleDepositsV3,
      bundleData.bundleFillsV3,
      bundleData.bundleSlowFillsV3,
      bundleData.unexecutableSlowFills,
      bundleData.expiredDepositsToRefundV3,
      {
        hubPoolClient,
        configStoreClient: hubPoolClient.configStoreClient as AcrossConfigStoreClient,
      }
    );
    return {
      root,
      blockRanges,
    };
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
      hubPoolClient.latestBlockSearched,
      hubPoolClient.chainId
    );
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
    const combinedRefunds: CombinedRefunds[] = [];

    // @dev: If spoke pool client is undefined for a chain, then the end block will be null or undefined, which
    // should be handled gracefully and effectively cause this function to ignore refunds for the chain.
    let widestBundleBlockRanges = getWidestPossibleExpectedBlockRange(
      chainIds,
      this.spokePoolClients,
      getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.configStoreClient.getEnabledChains(this.clients.hubPoolClient.latestBlockSearched)
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
      if (arweaveData === undefined) {
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
      const tokenAddress = refundLeaf.l2TokenAddress;
      if (executedRefunds[tokenAddress] === undefined) {
        executedRefunds[tokenAddress] = {};
      }
      const executedTokenRefunds = executedRefunds[tokenAddress];

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i];
        const refundAmount = refundLeaf.refundAmounts[i];
        if (executedTokenRefunds[relayer] === undefined) {
          executedTokenRefunds[relayer] = bnZero;
        }
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
      if (!isDefined(this.spokePoolClients[chainId])) {
        continue;
      }
      const executedRefunds = this.getExecutedRefunds(
        this.spokePoolClients[chainId],
        bundleContainingRefunds.relayerRefundRoot
      );

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

  getRefundsFor(bundleRefunds: CombinedRefunds, relayer: string, chainId: number, token: string): BigNumber {
    if (!bundleRefunds[chainId] || !bundleRefunds[chainId][token]) {
      return BigNumber.from(0);
    }
    const allRefunds = bundleRefunds[chainId][token];
    return allRefunds && allRefunds[relayer] ? allRefunds[relayer] : BigNumber.from(0);
  }

  getTotalRefund(refunds: CombinedRefunds[], relayer: string, chainId: number, refundToken: string): BigNumber {
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
          deposit.quoteBlockNumber
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
        Math.min(queryBlock, spokePoolClients[deposit.destinationChainId].latestBlockSearched),
        deposit.destinationChainId
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

    // We use the following toggle to aid with the migration to pre-fills. The first bundle proposed using this
    // pre-fill logic can double refund pre-fills that have already been filled in the last bundle, because the
    // last bundle did not recognize a fill as a pre-fill. Therefore the developer should ensure that the version
    // is bumped to the PRE_FILL_MIN_CONFIG_STORE_VERSION version before the first pre-fill bundle is proposed.
    // To test the following bundle after this, the developer can set the FORCE_REFUND_PREFILLS environment variable
    // to "true" simulate the bundle with pre-fill refunds.
    // @todo Remove this logic once we have advanced sufficiently past the pre-fill migration.
    const startBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[0];
    const versionAtProposalBlock = this.clients.configStoreClient.getConfigStoreVersionForBlock(startBlockForMainnet);
    const canRefundPrefills =
      versionAtProposalBlock >= PRE_FILL_MIN_CONFIG_STORE_VERSION || process.env.FORCE_REFUND_PREFILLS === "true";

    // Prerequisite step: Load all deposit events from the current or older bundles into the v3RelayHashes dictionary
    // for convenient matching with fills.
    let depositCounter = 0;
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      const originChainBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);

      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }
        originClient.getDepositsForDestinationChainWithDuplicates(destinationChainId).forEach((deposit) => {
          // Only evaluate deposits that are in this bundle or in previous bundles. This means we cannot issue fill
          // refunds or slow fills here for deposits that are in future bundles (i.e. "pre-fills"). Instead, we'll
          // evaluate these pre-fills once the deposit is inside the "current" bundle block range.
          if (deposit.blockNumber > originChainBlockRange[1] || isZeroValueDeposit(deposit)) {
            return;
          }
          depositCounter++;
          const relayDataHash = this.getRelayHashFromEvent(deposit);

          if (!v3RelayHashes[relayDataHash]) {
            v3RelayHashes[relayDataHash] = {
              deposits: [deposit],
              fill: undefined,
              slowFillRequest: undefined,
            };
          } else {
            v3RelayHashes[relayDataHash].deposits!.push(deposit);
          }

          // Once we've saved the deposit hash into v3RelayHashes, then we can exit early here if the inputAmount
          // is 0 because there can be no expired amount to refund and no unexecutable slow fill amount to return
          // if this deposit did expire. Input amount can only be zero at this point if the message is non-empty,
          // but the message doesn't matter for expired deposits and unexecutable slow fills.
          if (deposit.inputAmount.eq(0)) {
            return;
          }

          // Evaluate all expired deposits after fetching fill statuses,
          // since we can't know for certain whether an expired deposit was filled a long time ago.
          const newBundleDepositHash = `${relayDataHash}@${v3RelayHashes[relayDataHash].deposits!.length - 1}`;
          const decodedBundleDepositHash = decodeBundleDepositHash(newBundleDepositHash);
          assert(
            decodedBundleDepositHash.relayDataHash === relayDataHash &&
              decodedBundleDepositHash.index === v3RelayHashes[relayDataHash].deposits!.length - 1,
            "Not using correct bundle deposit hash key"
          );
          if (deposit.blockNumber >= originChainBlockRange[0]) {
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
      message: `Processed ${depositCounter} deposits in ${performance.now() - start}ms.`,
    });
    start = performance.now();

    // Process fills now that we've populated relay hash dictionary with deposits:
    const validatedBundleV3Fills: (V3FillWithBlock & { quoteTimestamp: number })[] = [];
    const validatedBundleSlowFills: V3DepositWithBlock[] = [];
    const validatedBundleUnexecutableSlowFills: V3DepositWithBlock[] = [];
    let fillCounter = 0;
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }

        const destinationClient = spokePoolClients[destinationChainId];
        const destinationChainBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);
        const originChainBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);

        // Keep track of fast fills that replaced slow fills, which we'll use to create "unexecutable" slow fills
        // if the slow fill request was sent in a prior bundle.
        const fastFillsReplacingSlowFills: string[] = [];
        await forEachAsync(
          destinationClient
            .getFillsForOriginChain(originChainId)
            // We can remove fills for deposits with input amount equal to zero because these will result in 0 refunded
            // tokens to the filler. We can't remove non-empty message deposit here in case there is a slow fill
            // request for the deposit, we'd want to see the fill took place.
            .filter(
              (fill) => fill.blockNumber <= destinationChainBlockRange[1] && !isZeroValueFillOrSlowFillRequest(fill)
            ),
          async (fill) => {
            fillCounter++;
            const relayDataHash = this.getRelayHashFromEvent(fill);
            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].fill) {
                assert(
                  isDefined(v3RelayHashes[relayDataHash].deposits) && v3RelayHashes[relayDataHash].deposits!.length > 0,
                  "Deposit should exist in relay hash dictionary."
                );
                // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                // so this fill can no longer be filled on-chain.
                v3RelayHashes[relayDataHash].fill = fill;
                if (fill.blockNumber >= destinationChainBlockRange[0]) {
                  const fillToRefund = await verifyFillRepayment(
                    fill,
                    destinationClient.spokePool.provider,
                    v3RelayHashes[relayDataHash].deposits![0],
                    allChainIds
                  );
                  if (!isDefined(fillToRefund)) {
                    // We won't repay the fill but the depositor has received funds so we don't need to make a
                    // payment.
                    bundleUnrepayableFillsV3.push(fill);
                    // We don't return here yet because we still need to mark unexecutable slow fill leaves
                    // or duplicate deposits. However, we won't issue a fast fill refund.
                  } else {
                    v3RelayHashes[relayDataHash].fill = fillToRefund;
                    validatedBundleV3Fills.push({
                      ...fillToRefund,
                      quoteTimestamp: v3RelayHashes[relayDataHash].deposits![0].quoteTimestamp, // ! due to assert above
                    });

                    // Now that we know this deposit has been filled on-chain, identify any duplicate deposits
                    // sent for this fill and refund them to the filler, because this value would not be paid out
                    // otherwise. These deposits can no longer expire and get refunded as an expired deposit,
                    // and they won't trigger a pre-fill refund because the fill is in this bundle.
                    // Pre-fill refunds only happen when deposits are sent in this bundle and the
                    // fill is from a prior bundle. Paying out the filler keeps the behavior consistent for how
                    // we deal with duplicate deposits regardless if the deposit is matched with a pre-fill or
                    // a current bundle fill.
                    const duplicateDeposits = v3RelayHashes[relayDataHash].deposits!.slice(1);
                    duplicateDeposits.forEach((duplicateDeposit) => {
                      // If fill is a slow fill, refund deposit to depositor, otherwise refund to filler.
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
                  // slow fill requests for deposits from or to lite chains are considered invalid
                  if (
                    fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill &&
                    _canCreateSlowFillLeaf(v3RelayHashes[relayDataHash].deposits![0])
                  ) {
                    fastFillsReplacingSlowFills.push(relayDataHash);
                  }
                }
              } else {
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

            // TODO: We might be able to remove the following historical query once we deprecate the deposit()
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

                const fillToRefund = await verifyFillRepayment(
                  fill,
                  destinationClient.spokePool.provider,
                  matchedDeposit,
                  allChainIds
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
                  assert(this.getRelayHashFromEvent(matchedDeposit) === relayDataHash, "Relay hashes should match.");
                  validatedBundleV3Fills.push({
                    ...fillToRefund,
                    quoteTimestamp: matchedDeposit.quoteTimestamp,
                  });
                  v3RelayHashes[relayDataHash].fill = fillToRefund;

                  // No need to check for duplicate deposits here since duplicate deposits with
                  // infinite deadlines are impossible to send via unsafeDeposit().
                }

                // slow fill requests for deposits from or to lite chains are considered invalid
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

        // Process slow fill requests. One invariant we need to maintain is that we cannot create slow fill requests
        // for deposits that would expire in this bundle.
        await forEachAsync(
          destinationClient
            .getSlowFillRequestsForOriginChain(originChainId)
            .filter(
              (request) =>
                request.blockNumber <= destinationChainBlockRange[1] && !isZeroValueFillOrSlowFillRequest(request)
            ),
          async (slowFillRequest: SlowFillRequestWithBlock) => {
            const relayDataHash = this.getRelayHashFromEvent(slowFillRequest);

            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].slowFillRequest) {
                // At this point, the v3RelayHashes entry already existed meaning that there is either a matching
                // fill or deposit.
                v3RelayHashes[relayDataHash].slowFillRequest = slowFillRequest;
                if (v3RelayHashes[relayDataHash].fill) {
                  // If there is a fill matching the relay hash, then this slow fill request can't be used
                  // to create a slow fill for a filled deposit. This takes advantage of the fact that
                  // slow fill requests must precede fills, so if there is a matching fill for this request's
                  // relay data, then this slow fill will be unexecutable.
                  return;
                }
                assert(
                  isDefined(v3RelayHashes[relayDataHash].deposits) && v3RelayHashes[relayDataHash].deposits!.length > 0,
                  "Deposit should exist in relay hash dictionary."
                );
                // The ! is safe here because we've already checked that the deposit exists in the relay hash dictionary.
                const matchedDeposit = v3RelayHashes[relayDataHash].deposits![0];

                // If there is no fill matching the relay hash, then this might be a valid slow fill request
                // that we should produce a slow fill leaf for. Check if the slow fill request is in the
                // destination chain block range.
                if (
                  slowFillRequest.blockNumber >= destinationChainBlockRange[0] &&
                  _canCreateSlowFillLeaf(matchedDeposit) &&
                  // Deposit must not have expired in this bundle.
                  !_depositIsExpired(matchedDeposit)
                ) {
                  // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                  // so this slow fill request relay data is correct.
                  validatedBundleSlowFills.push(matchedDeposit);
                }
              } else {
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

            // TODO: We might be able to remove the following historical query once we deprecate the deposit()
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
            if (
              INFINITE_FILL_DEADLINE.eq(slowFillRequest.fillDeadline) &&
              slowFillRequest.blockNumber >= destinationChainBlockRange[0]
            ) {
              const historicalDeposit = await queryHistoricalDepositForFill(originClient, slowFillRequest);
              if (!historicalDeposit.found) {
                // TODO: Invalid slow fill request. Maybe worth logging.
                return;
              }
              const matchedDeposit: V3DepositWithBlock = historicalDeposit.deposit;
              // If deposit is in a following bundle, then this slow fill request will have to be created
              // once that deposit is in the current bundle.
              if (matchedDeposit.blockNumber > originChainBlockRange[1]) {
                return;
              }
              // @dev Since queryHistoricalDepositForFill validates the slow fill request by checking individual
              // object property values against the deposit's, we
              // sanity check it here by comparing the full relay hashes. If there's an error here then the
              // historical deposit query is not working as expected.
              assert(
                this.getRelayHashFromEvent(matchedDeposit) === relayDataHash,
                "Deposit relay hashes should match."
              );
              v3RelayHashes[relayDataHash].deposits = [matchedDeposit];

              if (
                !_canCreateSlowFillLeaf(matchedDeposit) ||
                // Deposit must not have expired in this bundle.
                _depositIsExpired(matchedDeposit)
              ) {
                return;
              }
              validatedBundleSlowFills.push(matchedDeposit);
            }
          }
        );

        // Deposits can be submitted an arbitrary amount of time after matching fills and slow fill requests.
        // Therefore, let's go through each deposit in this bundle again and check a few things in order:
        // - Has the deposit been filled ? If so, then we need to issue a relayer refund for
        //   this "pre-fill" if the fill took place in a previous bundle.
        // - Or, has the deposit expired in this bundle? If so, then we need to issue an expiry refund.
        // - And finally, has the deposit been slow filled? If so, then we need to issue a slow fill leaf
        //   for this "pre-slow-fill-request" if this request took place in a previous bundle.
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

          // We are willing to refund a pre-fill multiple times for each duplicate deposit.
          // This is because a duplicate deposit for a pre-fill cannot get
          // refunded to the depositor anymore because its fill status on-chain has changed to Filled. Therefore
          // any duplicate deposits result in a net loss of funds for the depositor and effectively pay out
          // the pre-filler.

          // If fill exists in memory, then the only case in which we need to create a refund is if the
          // the fill occurred in a previous bundle. There are no expiry refunds for filled deposits.
          if (fill) {
            if (canRefundPrefills && fill.blockNumber < destinationChainBlockRange[0]) {
              // If fill is in the current bundle then we can assume there is already a refund for it, so only
              // include this pre fill if the fill is in an older bundle. If fill is after this current bundle, then
              // we won't consider it, following the previous treatment of fills after the bundle block range.
              if (!isSlowFill(fill)) {
                const fillToRefund = await verifyFillRepayment(
                  fill,
                  destinationClient.spokePool.provider,
                  v3RelayHashes[relayDataHash].deposits![0],
                  allChainIds
                );
                if (!isDefined(fillToRefund)) {
                  // We won't repay the fill but the depositor has received funds so we don't need to make a
                  // payment.
                  bundleUnrepayableFillsV3.push(fill);
                } else {
                  v3RelayHashes[relayDataHash].fill = fillToRefund;
                  validatedBundleV3Fills.push({
                    ...fillToRefund,
                    quoteTimestamp: deposit.quoteTimestamp,
                  });
                }
              } else {
                // Slow fills cannot result in refunds to a relayer to refund the deposit. Slow fills also
                // were created after the deposit was sent, so we can assume this deposit is a duplicate.
                updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
              }
            }
            return;
          }

          // If a slow fill request exists in memory, then we know the deposit has not been filled because fills
          // must follow slow fill requests and we would have seen the fill already if it existed. Therefore,
          // we can conclude that either the deposit has expired and we need to create a deposit expiry refund, or
          // we need to create a slow fill leaf for the deposit. The latter should only happen if the slow fill request
          // took place in a prior bundle otherwise we would have already created a slow fill leaf for it.
          if (slowFillRequest) {
            if (_depositIsExpired(deposit)) {
              updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
            } else if (
              canRefundPrefills &&
              slowFillRequest.blockNumber < destinationChainBlockRange[0] &&
              _canCreateSlowFillLeaf(deposit) &&
              validatedBundleSlowFills.every((d) => this.getRelayHashFromEvent(d) !== relayDataHash)
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

          // If deposit was filled, then we need to issue a refund for the fill and also any duplicate deposits
          // in the same bundle.
          if (fillStatus === FillStatus.Filled) {
            // We need to find the fill event to issue a refund to the right relayer and repayment chain,
            // or msg.sender if relayer address is invalid for the repayment chain. We don't need to
            // verify the fill block is before the bundle end block on the destination chain because
            // we queried the fillStatus at the end block. Therefore, if the fill took place after the end block,
            // then we wouldn't be in this branch of the code.
            const prefill = await this.findMatchingFillEvent(deposit, destinationClient);
            assert(isDefined(prefill), `findFillEvent# Cannot find prefill: ${relayDataHash}`);
            assert(this.getRelayHashFromEvent(prefill!) === relayDataHash, "Relay hashes should match.");
            if (canRefundPrefills) {
              const verifiedFill = await verifyFillRepayment(
                prefill!,
                destinationClient.spokePool.provider,
                deposit,
                allChainIds
              );
              if (!isDefined(verifiedFill)) {
                bundleUnrepayableFillsV3.push(prefill!);
              } else if (!isSlowFill(verifiedFill)) {
                validatedBundleV3Fills.push({
                  ...verifiedFill!,
                  quoteTimestamp: deposit.quoteTimestamp,
                });
              } else {
                // Slow fills cannot result in refunds to a relayer to refund the deposit. Slow fills also
                // were created after the deposit was sent, so we can assume this deposit is a duplicate.
                updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
              }
            }
          }
          // If deposit is not filled and its newly expired, we can create a deposit refund for it.
          // We don't check that fillDeadline >= bundleBlockTimestamps[destinationChainId][0] because
          // that would eliminate any deposits in this bundle with a very low fillDeadline like equal to 0
          // for example. Those should be included in this bundle of refunded deposits.
          else if (_depositIsExpired(deposit)) {
            updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
          }
          // If slow fill requested, then issue a slow fill leaf for the deposit.
          else if (
            fillStatus === FillStatus.RequestedSlowFill &&
            validatedBundleSlowFills.every((d) => this.getRelayHashFromEvent(d) !== relayDataHash)
          ) {
            // Input and Output tokens must be equivalent on the deposit for this to be slow filled.
            // Slow fill requests for deposits from or to lite chains are considered invalid
            if (canRefundPrefills && _canCreateSlowFillLeaf(deposit)) {
              // If deposit newly expired, then we can't create a slow fill leaf for it but we can
              // create a deposit refund for it.
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
          if (
            // If there is a slow fill request in this bundle that matches the relay hash, then there was no slow fill
            // created that would be considered excess.
            !slowFillRequest ||
            slowFillRequest.blockNumber < destinationBlockRange[0]
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
      // we should assume it was marked "newly expired" and refunded in a previous bundle.
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
        // assume a slow fill leaf was created for it because of the previous _canCreateSlowFillLeaf check.
        // The slow fill request was also sent before the fill deadline expired since we checked that above.
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
              const matchedDeposit = v3RelayHashes[this.getRelayHashFromEvent(fill)].deposits![0];
              assert(isDefined(matchedDeposit), "Deposit should exist in relay hash dictionary.");
              const { chainToSendRefundTo: paymentChainId } = getRefundInformationFromFill(
                fill,
                this.clients.hubPoolClient,
                blockRangesForChains,
                chainIds,
                matchedDeposit!.fromLiteChain
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
      const associatedDeposit = v3RelayHashes[this.getRelayHashFromEvent(fill)].deposits![0];
      assert(isDefined(associatedDeposit), "Deposit should exist in relay hash dictionary.");
      const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
        fill,
        this.clients.hubPoolClient,
        blockRangesForChains,
        chainIds,
        associatedDeposit!.fromLiteChain
      );
      updateBundleFillsV3(bundleFillsV3, fill, realizedLpFeePct, chainToSendRefundTo, repaymentToken, fill.relayer);
    });
    v3SlowFillLpFees.forEach(({ realizedLpFeePct: lpFeePct }, idx) => {
      const deposit = validatedBundleSlowFills[idx];
      // We should not create slow fill leaves for duplicate deposit hashes and we should only create a slow
      // fill leaf for the first deposit (the quote timestamp of the deposit determines the LP fee, so its
      // important we pick out the correct deposit). Deposits are pushed into validatedBundleSlowFills in ascending
      // order so the following slice will only match the first deposit.
      const relayDataHash = this.getRelayHashFromEvent(deposit);
      if (validatedBundleSlowFills.slice(0, idx).some((d) => this.getRelayHashFromEvent(d) === relayDataHash)) {
        return;
      }
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
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some invalid V3 fills in range",
        blockRangesForChains,
        bundleInvalidFillsV3,
      });
    }

    if (bundleUnrepayableFillsV3.length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some unrepayable V3 fills in range",
        blockRangesForChains,
        bundleUnrepayableFillsV3,
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

  // Internal function to uniquely identify a bridge event. This is preferred over `SDK.getRelayDataHash` which returns
  // keccak256 hash of the relay data, which can be used as input into the on-chain `fillStatuses()` function in the
  // spoke pool contract. However, this internal function is used to uniquely identify a bridging event
  // for speed since its easier to build a string from the event data than to hash it.
  protected getRelayHashFromEvent(event: V3DepositWithBlock | V3FillWithBlock | SlowFillRequestWithBlock): string {
    return `${event.depositor}-${event.recipient}-${event.exclusiveRelayer}-${event.inputToken}-${event.outputToken}-${
      event.inputAmount
    }-${event.outputAmount}-${event.originChainId}-${event.depositId.toString()}-${event.fillDeadline}-${
      event.exclusivityDeadline
    }-${event.message}-${event.destinationChainId}`;
  }

  protected async findMatchingFillEvent(
    deposit: DepositWithBlock,
    spokePoolClient: SpokePoolClient
  ): Promise<FillWithBlock | undefined> {
    return await findFillEvent(
      spokePoolClient.spokePool,
      deposit,
      spokePoolClient.deploymentBlock,
      spokePoolClient.latestBlockSearched
    );
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
          const startBlockForChain = Math.min(_startBlockForChain, spokePoolClient.latestBlockSearched);
          // @dev Add 1 to the bundle end block. The thinking here is that there can be a gap between
          // block timestamps in subsequent blocks. The bundle data client assumes that fill deadlines expire
          // in exactly one bundle, therefore we must make sure that the bundle block timestamp for one bundle's
          // end block is exactly equal to the bundle block timestamp for the next bundle's start block. This way
          // there are no gaps in block timestamps between bundles.
          const endBlockForChain = Math.min(_endBlockForChain + 1, spokePoolClient.latestBlockSearched);
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
