import assert from "assert";
import { BigNumber, Contract, Event, EventFilter } from "ethers";
import _ from "lodash";
import winston from "winston";
import { DEFAULT_CACHING_SAFE_LAG, DEFAULT_CACHING_TTL } from "../constants";
import {
  CachingMechanismInterface,
  CancelledRootBundle,
  CrossChainContractsSet,
  Deposit,
  DestinationTokenWithBlock,
  DisputedRootBundle,
  ExecutedRootBundle,
  L1Token,
  LpToken,
  PendingRootBundle,
  ProposedRootBundle,
  RealizedLpFee,
  SetPoolRebalanceRoot,
  TokenRunningBalance,
  V2DepositWithBlock,
  V3DepositWithBlock,
} from "../interfaces";
import * as lpFeeCalculator from "../lpFeeCalculator";
import {
  BlockFinder,
  bnZero,
  dedupArray,
  EventSearchConfig,
  MakeOptional,
  assign,
  fetchTokenInfo,
  getCachedBlockForTimestamp,
  getCurrentTime,
  getDepositInputToken,
  getNetworkName,
  isDefined,
  isV3Deposit,
  mapAsync,
  paginatedEventQuery,
  shouldCache,
  sortEventsDescending,
  spreadEvent,
  spreadEventWithBlockNumber,
  toBN,
} from "../utils";
import { AcrossConfigStoreClient as ConfigStoreClient } from "./AcrossConfigStoreClient/AcrossConfigStoreClient";
import { BaseAbstractClient } from "./BaseAbstractClient";

type _HubPoolUpdate = {
  success: true;
  currentTime: number;
  pendingRootBundleProposal: PendingRootBundle;
  events: Record<string, Event[]>;
  searchEndBlock: number;
};
export type HubPoolUpdate = { success: false } | _HubPoolUpdate;

type HubPoolEvent =
  | "SetPoolRebalanceRoute"
  | "L1TokenEnabledForLiquidityProvision"
  | "ProposeRootBundle"
  | "RootBundleCanceled"
  | "RootBundleDisputed"
  | "RootBundleExecuted"
  | "CrossChainContractsSet";

type L1TokensToDestinationTokens = {
  [l1Token: string]: { [destinationChainId: number]: string };
};

// Temporary type for v2 -> v3 transition. @todo: Remove.
type V2PartialDepositWithBlock = Pick<
  V2DepositWithBlock,
  "originChainId" | "originToken" | "amount" | "quoteTimestamp"
>;

// Temporary type for v2 -> v3 transition. @todo: Remove.
type V3PartialDepositWithBlock = Pick<
  V3DepositWithBlock,
  "originChainId" | "inputToken" | "inputAmount" | "quoteTimestamp"
>;

export type LpFeeRequest = (V2PartialDepositWithBlock | V3PartialDepositWithBlock) & { paymentChainId?: number };

export class HubPoolClient extends BaseAbstractClient {
  // L1Token -> destinationChainId -> destinationToken
  protected l1TokensToDestinationTokens: L1TokensToDestinationTokens = {};
  protected l1Tokens: L1Token[] = []; // L1Tokens and their associated info.
  protected lpTokens: { [token: string]: LpToken } = {};
  protected proposedRootBundles: ProposedRootBundle[] = [];
  protected canceledRootBundles: CancelledRootBundle[] = [];
  protected disputedRootBundles: DisputedRootBundle[] = [];
  protected executedRootBundles: ExecutedRootBundle[] = [];
  protected crossChainContracts: { [l2ChainId: number]: CrossChainContractsSet[] } = {};
  protected l1TokensToDestinationTokensWithBlock: {
    [l1Token: string]: { [destinationChainId: number]: DestinationTokenWithBlock[] };
  } = {};
  protected pendingRootBundle: PendingRootBundle | undefined;

  public currentTime: number | undefined;
  public readonly blockFinder: BlockFinder;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    public configStoreClient: ConfigStoreClient,
    public deploymentBlock = 0,
    readonly chainId: number = 1,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    protected readonly configOverride: {
      ignoredHubExecutedBundles: number[];
      ignoredHubProposedBundles: number[];
      timeToCache?: number;
    } = {
      ignoredHubExecutedBundles: [],
      ignoredHubProposedBundles: [],
    },
    cachingMechanism?: CachingMechanismInterface
  ) {
    super(cachingMechanism);
    this.latestBlockSearched = Math.min(deploymentBlock - 1, 0);
    this.firstBlockToSearch = eventSearchConfig.fromBlock;

    const provider = this.hubPool.provider;
    this.blockFinder = new BlockFinder(provider);
  }

  protected hubPoolEventFilters(): Record<HubPoolEvent, EventFilter> {
    return {
      SetPoolRebalanceRoute: this.hubPool.filters.SetPoolRebalanceRoute(),
      L1TokenEnabledForLiquidityProvision: this.hubPool.filters.L1TokenEnabledForLiquidityProvision(),
      ProposeRootBundle: this.hubPool.filters.ProposeRootBundle(),
      RootBundleCanceled: this.hubPool.filters.RootBundleCanceled(),
      RootBundleDisputed: this.hubPool.filters.RootBundleDisputed(),
      RootBundleExecuted: this.hubPool.filters.RootBundleExecuted(),
      CrossChainContractsSet: this.hubPool.filters.CrossChainContractsSet(),
    };
  }

  hasPendingProposal(): boolean {
    return this.pendingRootBundle !== undefined;
  }

  getPendingRootBundle(): PendingRootBundle | undefined {
    return this.pendingRootBundle;
  }

  getProposedRootBundles(): ProposedRootBundle[] {
    return this.proposedRootBundles;
  }

  getCancelledRootBundles(): CancelledRootBundle[] {
    return this.canceledRootBundles;
  }

  getDisputedRootBundles(): DisputedRootBundle[] {
    return this.disputedRootBundles;
  }

  getExecutedRootBundles(): ExecutedRootBundle[] {
    return this.executedRootBundles;
  }

  getSpokePoolForBlock(chain: number, block: number = Number.MAX_SAFE_INTEGER): string {
    if (!this.crossChainContracts[chain]) {
      throw new Error(`No cross chain contracts set for ${chain}`);
    }
    const mostRecentSpokePoolUpdateBeforeBlock = (
      sortEventsDescending(this.crossChainContracts[chain]) as CrossChainContractsSet[]
    ).find((crossChainContract) => crossChainContract.blockNumber <= block);
    if (!mostRecentSpokePoolUpdateBeforeBlock) {
      throw new Error(`No cross chain contract found before block ${block} for chain ${chain}`);
    } else {
      return mostRecentSpokePoolUpdateBeforeBlock.spokePool;
    }
  }

  getSpokePoolActivationBlock(chain: number, spokePool: string): number | undefined {
    // Return first time that this spoke pool was registered in the HubPool as a cross chain contract. We can use
    // this block as the oldest block that we should query for SpokePoolClient purposes.
    const mostRecentSpokePoolUpdateBeforeBlock = this.crossChainContracts[chain].find(
      (crossChainContract) => crossChainContract.spokePool === spokePool
    );
    return mostRecentSpokePoolUpdateBeforeBlock?.blockNumber;
  }

  // Returns the latest L2 token to use for an L1 token as of the input hub block.
  getL2TokenForL1TokenAtBlock(
    l1Token: string,
    destinationChainId: number,
    latestHubBlock = Number.MAX_SAFE_INTEGER
  ): string {
    if (!this.l1TokensToDestinationTokensWithBlock?.[l1Token]?.[destinationChainId]) {
      const chain = getNetworkName(destinationChainId);
      const { symbol } = this.l1Tokens.find(({ address }) => address === l1Token) ?? { symbol: l1Token };
      throw new Error(`Could not find SpokePool mapping for ${symbol} on ${chain} and L1 token ${l1Token}`);
    }
    // Find the last mapping published before the target block.
    const l2Token: DestinationTokenWithBlock | undefined = sortEventsDescending(
      this.l1TokensToDestinationTokensWithBlock[l1Token][destinationChainId]
    ).find((mapping: DestinationTokenWithBlock) => mapping.blockNumber <= latestHubBlock);
    if (!l2Token) {
      const chain = getNetworkName(destinationChainId);
      const { symbol } = this.l1Tokens.find(({ address }) => address === l1Token) ?? { symbol: l1Token };
      throw new Error(
        `Could not find SpokePool mapping for ${symbol} on ${chain} at or before HubPool block ${latestHubBlock}!`
      );
    }
    return l2Token.l2Token;
  }

  // Returns the latest L1 token to use for an L2 token as of the input hub block.
  getL1TokenForL2TokenAtBlock(
    l2Token: string,
    destinationChainId: number,
    latestHubBlock = Number.MAX_SAFE_INTEGER
  ): string {
    const l2Tokens = Object.keys(this.l1TokensToDestinationTokensWithBlock)
      .filter((l1Token) => this.l2TokenEnabledForL1Token(l1Token, destinationChainId))
      .map((l1Token) => {
        // Return all matching L2 token mappings that are equal to or earlier than the target block.
        return this.l1TokensToDestinationTokensWithBlock[l1Token][destinationChainId].filter(
          (mapping) => mapping.l2Token === l2Token && mapping.blockNumber <= latestHubBlock
        );
      })
      .flat();
    if (l2Tokens.length === 0) {
      const chain = getNetworkName(destinationChainId);
      throw new Error(
        `Could not find HubPool mapping for ${l2Token} on ${chain} at or before HubPool block ${latestHubBlock}!`
      );
    }
    // Find the last mapping published before the target block.
    return sortEventsDescending(l2Tokens)[0].l1Token;
  }

  /**
   * Returns the L1 token that should be used for an L2 Bridge event. This function is
   * designed to be used by the caller to associate the L2 token with its mapped L1 token
   * at the HubPool equivalent block number of the L2 event.
   * @param deposit Deposit event
   * @param returns string L1 token counterpart for Deposit
   */
  getL1TokenForDeposit(
    deposit:
      | Pick<V2DepositWithBlock, "originChainId" | "originToken" | "quoteBlockNumber">
      | Pick<V3DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber">
  ): string {
    // L1-->L2 token mappings are set via PoolRebalanceRoutes which occur on mainnet,
    // so we use the latest token mapping. This way if a very old deposit is filled, the relayer can use the
    // latest L2 token mapping to find the L1 token counterpart.
    const inputToken = getDepositInputToken(deposit);
    return this.getL1TokenForL2TokenAtBlock(inputToken, deposit.originChainId, deposit.quoteBlockNumber);
  }

  /**
   * Returns the L2 token that should be used as a counterpart to a deposit event. For example, the caller
   * might want to know what the refund token will be on l2ChainId for the deposit event.
   * @param l2ChainId Chain where caller wants to get L2 token counterpart for
   * @param event Deposit event
   * @returns string L2 token counterpart on l2ChainId
   */
  getL2TokenForDeposit(
    deposit:
      | Pick<V2DepositWithBlock, "originChainId" | "destinationChainId" | "originToken" | "quoteBlockNumber">
      | Pick<V3DepositWithBlock, "originChainId" | "destinationChainId" | "inputToken" | "quoteBlockNumber">,
    l2ChainId = deposit.destinationChainId
  ): string {
    const l1Token = this.getL1TokenForDeposit(deposit);
    // Use the latest hub block number to find the L2 token counterpart.
    return this.getL2TokenForL1TokenAtBlock(l1Token, l2ChainId, deposit.quoteBlockNumber);
  }

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number): boolean {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId] != undefined;
  }

  getBlockNumber(timestamp: number): Promise<number | undefined> {
    const hints = { lowBlock: this.deploymentBlock };
    return getCachedBlockForTimestamp(this.chainId, timestamp, this.blockFinder, this.cachingMechanism, hints);
  }

  async getCurrentPoolUtilization(l1Token: string): Promise<BigNumber> {
    const blockNumber = this.latestBlockSearched ?? (await this.hubPool.provider.getBlockNumber());
    return await this.getUtilization(l1Token, blockNumber, bnZero, getCurrentTime(), 0);
  }

  /**
   * For a HubPool token at a specific block number, compute the relevant utilization.
   * @param hubPoolToken HubPool token to query utilization for.
   * @param blocknumber Block number to query utilization at.
   * @param amount Amount to query. If set to 0, the closing utilization at blockNumber is returned.
   * @param amount timestamp Associated quoteTimestamp for query, used for caching evaluation.
   * @param timeToCache Age at which the response is able to be cached.
   * @returns HubPool utilization at `blockNumber` after optional `amount` increase in utilization.
   */
  protected async getUtilization(
    hubPoolToken: string,
    blockNumber: number,
    depositAmount: BigNumber,
    timestamp: number,
    timeToCache: number
  ): Promise<BigNumber> {
    // Resolve this function call as an async anonymous function
    const resolver = async () => {
      const overrides = { blockTag: blockNumber };
      if (depositAmount.eq(0)) {
        // For zero amount, just get the utilisation at `blockNumber`.
        return await this.hubPool.callStatic.liquidityUtilizationCurrent(hubPoolToken, overrides);
      }

      return await this.hubPool.callStatic.liquidityUtilizationPostRelay(hubPoolToken, depositAmount, overrides);
    };

    // Resolve the cache locally so that we can appease typescript
    const cache = this.cachingMechanism;

    // If there is no cache or the timestamp is not old enough to be cached, just resolve the function.
    if (!cache || !shouldCache(getCurrentTime(), timestamp, timeToCache)) {
      return resolver();
    }

    // Otherwise, let's resolve the key
    // @note Avoid collisions with pre-existing cache keys by appending an underscore (_) for post-relay utilization.
    // @fixme This can be removed once the existing keys have been ejected from the cache (i.e. 7 days).
    const key = depositAmount.eq(0)
      ? `utilization_${hubPoolToken}_${blockNumber}`
      : `utilization_${hubPoolToken}_${blockNumber}_${depositAmount.toString()}_`;
    const result = await cache.get<string>(key);
    if (isDefined(result)) {
      return BigNumber.from(result);
    }

    // We were not able to find a valid result, so let's resolve the function.
    const utilization = await resolver();
    if (cache && shouldCache(getCurrentTime(), timestamp, timeToCache)) {
      // If we should cache the result, store it for up to DEFAULT_CACHING_TTL.
      await cache.set(key, `${utilization.toString()}`, DEFAULT_CACHING_TTL);
    }

    return utilization;
  }

  async computeRealizedLpFeePct(deposit: LpFeeRequest): Promise<RealizedLpFee> {
    const [lpFee] = await this.batchComputeRealizedLpFeePct([deposit]);
    return lpFee;
  }

  async batchComputeRealizedLpFeePct(_deposits: LpFeeRequest[]): Promise<RealizedLpFee[]> {
    assert(_deposits.length > 0, "No deposits supplied to batchComputeRealizedLpFeePct");
    if (!isDefined(this.currentTime)) {
      throw new Error("HubPoolClient has not set a currentTime");
    }

    const deposits = _deposits.map((deposit) => {
      if (isV3Deposit(deposit)) {
        return deposit;
      }

      const { originToken: inputToken, amount: inputAmount, ...partialDeposit } = deposit;
      return { ...partialDeposit, inputToken, inputAmount };
    });

    // Map each HubPool token to an array of unqiue quoteTimestamps.
    const utilizationTimestamps: { [hubPoolToken: string]: number[] } = {};

    // Map each HubPool token to utilization at a particular block number.
    let utilization: { [hubPoolToken: string]: { [blockNumber: number]: BigNumber } } = {};

    let quoteBlocks: { [quoteTimestamp: number]: number } = {};

    // Map SpokePool token addresses to HubPool token addresses.
    // Note: Should only be accessed via `getHubPoolToken()` or `getHubPoolTokens()`.
    const hubPoolTokens: { [k: string]: string } = {};
    const getHubPoolToken = (deposit: V3PartialDepositWithBlock, quoteBlockNumber: number): string => {
      const tokenKey = `${deposit.originChainId}-${deposit.inputToken}`;
      return (hubPoolTokens[tokenKey] ??= this.getL1TokenForDeposit({ ...deposit, quoteBlockNumber }));
    };
    const getHubPoolTokens = (): string[] => dedupArray(Object.values(hubPoolTokens));

    // Helper to resolve the unqiue hubPoolToken & quoteTimestamp mappings.
    const resolveUniqueQuoteTimestamps = (deposit: V3PartialDepositWithBlock): void => {
      const { quoteTimestamp } = deposit;

      // Resolve the HubPool token address for this origin chainId/token pair, if it isn't already known.
      const quoteBlockNumber = quoteBlocks[quoteTimestamp];
      const hubPoolToken = getHubPoolToken(deposit, quoteBlockNumber);

      // Append the quoteTimestamp for this HubPool token, if it isn't already enqueued.
      utilizationTimestamps[hubPoolToken] ??= [];
      if (!utilizationTimestamps[hubPoolToken].includes(quoteTimestamp)) {
        utilizationTimestamps[hubPoolToken].push(quoteTimestamp);
      }
    };

    // Helper to resolve a quoteTimestamp to a HubPool block number.
    const resolveTimestampsToBlocks = async (quoteTimestamp: number): Promise<[number, number]> => {
      const quoteBlock = await this.getBlockNumber(quoteTimestamp);
      if (!isDefined(quoteBlock)) {
        throw new Error(`Could not find block for timestamp ${quoteTimestamp}`);
      }
      return [quoteTimestamp, quoteBlock];
    };

    // Helper to resolve existing HubPool token utilisation for an array of unique block numbers.
    // Produces a mapping of blockNumber -> utilization for a specific token.
    const resolveUtilization = async (hubPoolToken: string): Promise<Record<number, BigNumber>> => {
      return Object.fromEntries(
        await mapAsync(utilizationTimestamps[hubPoolToken], async (quoteTimestamp) => {
          const blockNumber = quoteBlocks[quoteTimestamp];
          const utilization = await this.getUtilization(
            hubPoolToken,
            blockNumber,
            bnZero, // amount
            quoteTimestamp,
            timeToCache
          );
          return [blockNumber, utilization];
        })
      );
    };

    // Helper compute the realizedLpFeePct of an individual deposit based on pre-retrieved batch data.
    const computeRealizedLpFeePct = async (deposit: V3PartialDepositWithBlock & { paymentChainId?: number }) => {
      const { originChainId, paymentChainId, inputAmount, quoteTimestamp } = deposit;
      const quoteBlock = quoteBlocks[quoteTimestamp];

      if (paymentChainId === undefined) {
        return { quoteBlock, realizedLpFeePct: bnZero };
      }

      const hubPoolToken = getHubPoolToken(deposit, quoteBlock);
      const rateModel = this.configStoreClient.getRateModelForBlockNumber(
        hubPoolToken,
        originChainId,
        paymentChainId,
        quoteBlock
      );

      const preUtilization = utilization[hubPoolToken][quoteBlock];
      const postUtilization = await this.getUtilization(
        hubPoolToken,
        quoteBlock,
        inputAmount,
        quoteTimestamp,
        timeToCache
      );
      const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(rateModel, preUtilization, postUtilization);

      return { quoteBlock, realizedLpFeePct };
    };

    /**
     * Execution flow starts here.
     */
    const timeToCache = this.configOverride.timeToCache ?? DEFAULT_CACHING_SAFE_LAG;

    // Identify the unique hubPoolToken & quoteTimestamp mappings. This is used to optimise subsequent HubPool queries.
    deposits.forEach((deposit) => resolveUniqueQuoteTimestamps(deposit));

    // Filter all deposits for unique quoteTimestamps, to be resolved to a blockNumber in parallel.
    const quoteTimestamps = dedupArray(deposits.map(({ quoteTimestamp }) => quoteTimestamp));
    quoteBlocks = Object.fromEntries(
      await mapAsync(quoteTimestamps, (quoteTimestamp) => resolveTimestampsToBlocks(quoteTimestamp))
    );

    // For each token / quoteBlock pair, resolve the utilisation for each quoted block.
    // This can be reused for each deposit with the same HubPool token and quoteTimestamp pair.
    utilization = Object.fromEntries(
      await mapAsync(getHubPoolTokens(), async (hubPoolToken) => [hubPoolToken, await resolveUtilization(hubPoolToken)])
    );

    // For each deposit, compute the post-relay HubPool utilisation independently.
    // @dev The caller expects to receive an array in the same length and ordering as the input `deposits`.
    return await mapAsync(deposits, (deposit) => computeRealizedLpFeePct(deposit));
  }

  getL1Tokens(): L1Token[] {
    return this.l1Tokens;
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
    return this.l1Tokens.find((token) => token.address === l1Token);
  }

  getLpTokenInfoForL1Token(l1Token: string): LpToken | undefined {
    return this.lpTokens[l1Token];
  }

  getL1TokenInfoForL2Token(l2Token: string, chainId: number): L1Token | undefined {
    const l1TokenCounterpart = this.getL1TokenForL2TokenAtBlock(l2Token, chainId, this.latestBlockSearched);
    return this.getTokenInfoForL1Token(l1TokenCounterpart);
  }

  getTokenInfoForDeposit(deposit: Deposit): L1Token | undefined {
    const inputToken = getDepositInputToken(deposit);
    return this.getTokenInfoForL1Token(
      this.getL1TokenForL2TokenAtBlock(inputToken, deposit.originChainId, this.latestBlockSearched)
    );
  }

  getTokenInfo(chainId: number | string, tokenAddress: string): L1Token | undefined {
    const deposit = { originChainId: parseInt(chainId.toString()), originToken: tokenAddress } as Deposit;
    return this.getTokenInfoForDeposit(deposit);
  }

  areTokensEquivalent(
    tokenA: string,
    chainIdA: number,
    tokenB: string,
    chainIdB: number,
    hubPoolBlock = this.latestBlockSearched
  ): boolean {
    try {
      // Resolve both SpokePool tokens back to their respective HubPool tokens and verify that they match.
      const l1TokenA = this.getL1TokenForL2TokenAtBlock(tokenA, chainIdA, hubPoolBlock);
      const l1TokenB = this.getL1TokenForL2TokenAtBlock(tokenB, chainIdB, hubPoolBlock);
      if (l1TokenA !== l1TokenB) {
        return false;
      }

      // Resolve both HubPool tokens back to a current SpokePool token and verify that they match.
      const _tokenA = this.getL2TokenForL1TokenAtBlock(l1TokenA, chainIdA, hubPoolBlock);
      const _tokenB = this.getL2TokenForL1TokenAtBlock(l1TokenB, chainIdB, hubPoolBlock);
      return tokenA === _tokenA && tokenB === _tokenB;
    } catch {
      return false; // One or both input tokens were not recognised.
    }
  }

  getSpokeActivationBlockForChain(chainId: number): number {
    return this.getSpokePoolActivationBlock(chainId, this.getSpokePoolForBlock(chainId)) ?? 0;
  }

  // Root bundles are valid if all of their pool rebalance leaves have been executed before the next bundle, or the
  // latest mainnet block to search. Whichever comes first.
  isRootBundleValid(rootBundle: ProposedRootBundle, latestMainnetBlock: number): boolean {
    const nextRootBundle = this.getFollowingRootBundle(rootBundle);
    const executedLeafCount = this.getExecutedLeavesForRootBundle(
      rootBundle,
      nextRootBundle ? Math.min(nextRootBundle.blockNumber, latestMainnetBlock) : latestMainnetBlock
    );
    return executedLeafCount.length === rootBundle.poolRebalanceLeafCount;
  }

  // This should find the ProposeRootBundle event whose bundle block number for `chain` is closest to the `block`
  // without being smaller. It returns the bundle block number for the chain or undefined if not matched.
  getRootBundleEvalBlockNumberContainingBlock(
    latestMainnetBlock: number,
    block: number,
    chain: number,
    chainIdListOverride?: number[]
  ): number | undefined {
    const chainIdList = chainIdListOverride ?? this.configStoreClient.getChainIdIndicesForBlock(latestMainnetBlock);
    let endingBlockNumber: number | undefined;
    // Search proposed root bundles in reverse chronological order.
    for (let i = this.proposedRootBundles.length - 1; i >= 0; i--) {
      const rootBundle = this.proposedRootBundles[i];
      const nextRootBundle = this.getFollowingRootBundle(rootBundle);
      if (!this.isRootBundleValid(rootBundle, nextRootBundle ? nextRootBundle.blockNumber : latestMainnetBlock)) {
        continue;
      }

      // 0 is the default value bundleEvalBlockNumber.
      const bundleEvalBlockNumber = this.getBundleEndBlockForChain(
        rootBundle as ProposedRootBundle,
        chain,
        chainIdList
      );

      // Since we're iterating from newest to oldest, bundleEvalBlockNumber is only decreasing, and if the
      // bundleEvalBlockNumber is smaller than the target block, then we should return the last set `endingBlockNumber`.
      if (bundleEvalBlockNumber <= block) {
        if (bundleEvalBlockNumber === block) {
          endingBlockNumber = bundleEvalBlockNumber;
        }
        break;
      }
      endingBlockNumber = bundleEvalBlockNumber;
    }
    return endingBlockNumber;
  }

  // TODO: This might not be necessary since the cumulative root bundle count doesn't grow fast enough, but consider
  // using _.findLast/_.find instead of resorting the arrays if these functions begin to take a lot time.
  getProposedRootBundlesInBlockRange(startingBlock: number, endingBlock: number): ProposedRootBundle[] {
    return this.proposedRootBundles.filter(
      (bundle: ProposedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getCancelledRootBundlesInBlockRange(startingBlock: number, endingBlock: number): CancelledRootBundle[] {
    return sortEventsDescending(this.canceledRootBundles).filter(
      (bundle: CancelledRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getDisputedRootBundlesInBlockRange(startingBlock: number, endingBlock: number): DisputedRootBundle[] {
    return sortEventsDescending(this.disputedRootBundles).filter(
      (bundle: DisputedRootBundle) => bundle.blockNumber >= startingBlock && bundle.blockNumber <= endingBlock
    );
  }

  getLatestProposedRootBundle(): ProposedRootBundle {
    return this.proposedRootBundles[this.proposedRootBundles.length - 1] as ProposedRootBundle;
  }

  getFollowingRootBundle(currentRootBundle: ProposedRootBundle): ProposedRootBundle | undefined {
    const index = _.findLastIndex(
      this.proposedRootBundles,
      (bundle) => bundle.blockNumber === currentRootBundle.blockNumber
    );
    // If index of current root bundle is not found or is the last bundle, return undefined.
    if (index === -1 || index === this.proposedRootBundles.length - 1) {
      return undefined;
    }
    return this.proposedRootBundles[index + 1];
  }

  getExecutedLeavesForRootBundle(
    rootBundle: ProposedRootBundle,
    latestMainnetBlockToSearch: number
  ): ExecutedRootBundle[] {
    return this.executedRootBundles.filter(
      (executedLeaf: ExecutedRootBundle) =>
        executedLeaf.blockNumber <= latestMainnetBlockToSearch &&
        // Note: We can use > instead of >= here because a leaf can never be executed in same block as its root
        // proposal due to bundle liveness enforced by HubPool. This importantly avoids the edge case
        // where the execution all leaves occurs in the same block as the next proposal, leading us to think
        // that the next proposal is fully executed when its not.
        executedLeaf.blockNumber > rootBundle.blockNumber
    ) as ExecutedRootBundle[];
  }

  getValidatedRootBundles(latestMainnetBlock: number = Number.MAX_SAFE_INTEGER): ProposedRootBundle[] {
    return this.proposedRootBundles.filter((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getLatestFullyExecutedRootBundle(latestMainnetBlock: number): ProposedRootBundle | undefined {
    // Search for latest ProposeRootBundleExecuted event followed by all of its RootBundleExecuted event suggesting
    // that all pool rebalance leaves were executed. This ignores any proposed bundles that were partially executed.
    return _.findLast(this.proposedRootBundles, (rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  getEarliestFullyExecutedRootBundle(latestMainnetBlock: number, startBlock = 0): ProposedRootBundle | undefined {
    return this.proposedRootBundles.find((rootBundle: ProposedRootBundle) => {
      if (rootBundle.blockNumber > latestMainnetBlock) {
        return false;
      }
      if (rootBundle.blockNumber < startBlock) {
        return false;
      }
      return this.isRootBundleValid(rootBundle, latestMainnetBlock);
    });
  }

  // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
  // executed bundle. Latest means most recent, earliest means oldest. N cannot be 0.
  // `startBlock` can be used to set the starting point from which we look forwards or backwards, depending
  // on whether n is positive or negative.
  getNthFullyExecutedRootBundle(n: number, startBlock?: number): ProposedRootBundle | undefined {
    if (n === 0) {
      throw new Error("n cannot be 0");
    }
    if (!this.latestBlockSearched) {
      throw new Error("HubPoolClient::getNthFullyExecutedRootBundle client not updated");
    }

    let bundleToReturn: ProposedRootBundle | undefined;

    // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
    // executed bundle.
    if (n < 0) {
      let nextLatestMainnetBlock = startBlock ?? this.latestBlockSearched;
      for (let i = 0; i < Math.abs(n); i++) {
        bundleToReturn = this.getLatestFullyExecutedRootBundle(nextLatestMainnetBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Subtract 1 so that next `getLatestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is > nextLatestMainnetBlock.
        nextLatestMainnetBlock = Math.max(0, bundleBlockNumber - 1);
      }
    } else {
      let nextStartBlock = startBlock ?? 0;
      for (let i = 0; i < n; i++) {
        bundleToReturn = this.getEarliestFullyExecutedRootBundle(this.latestBlockSearched, nextStartBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Add 1 so that next `getEarliestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is < nextStartBlock.
        nextStartBlock = Math.min(bundleBlockNumber + 1, this.latestBlockSearched);
      }
    }

    return bundleToReturn;
  }

  getLatestBundleEndBlockForChain(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    const latestFullyExecutedPoolRebalanceRoot = this.getLatestFullyExecutedRootBundle(latestMainnetBlock);

    // If no event, then we can return a conservative default starting block like 0,
    // or we could throw an Error.
    if (!latestFullyExecutedPoolRebalanceRoot) {
      return 0;
    }

    // Once this proposal event is found, determine its mapping of indices to chainId in its
    // bundleEvaluationBlockNumbers array using CHAIN_ID_LIST. For each chainId, their starting block number is that
    // chain's bundleEvaluationBlockNumber + 1 in this past proposal event.
    return this.getBundleEndBlockForChain(latestFullyExecutedPoolRebalanceRoot, chainId, chainIdList);
  }

  getNextBundleStartBlockNumber(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    const endBlock = this.getLatestBundleEndBlockForChain(chainIdList, latestMainnetBlock, chainId);

    // This assumes that chain ID's are only added to the chain ID list over time, and that chains are never
    // deleted.
    return endBlock > 0 ? endBlock + 1 : 0;
  }

  getRunningBalanceBeforeBlockForChain(block: number, chain: number, l1Token: string): TokenRunningBalance {
    // Search ExecutedRootBundles in descending block order to find the most recent event before the target block.
    const executedRootBundle = sortEventsDescending(this.executedRootBundles).find(
      (executedLeaf: ExecutedRootBundle) => {
        return (
          executedLeaf.blockNumber <= block &&
          executedLeaf.chainId === chain &&
          executedLeaf.l1Tokens.map((l1Token) => l1Token.toLowerCase()).includes(l1Token.toLowerCase())
        );
      }
    ) as ExecutedRootBundle;

    return this.getRunningBalanceForToken(l1Token, executedRootBundle);
  }

  public getRunningBalanceForToken(l1Token: string, executedRootBundle: ExecutedRootBundle): TokenRunningBalance {
    let runningBalance = toBN(0);
    let incentiveBalance = toBN(0);
    if (executedRootBundle) {
      const indexOfL1Token = executedRootBundle.l1Tokens
        .map((l1Token) => l1Token.toLowerCase())
        .indexOf(l1Token.toLowerCase());
      runningBalance = executedRootBundle.runningBalances[indexOfL1Token];
      incentiveBalance = executedRootBundle.incentiveBalances[indexOfL1Token];
    }

    return { runningBalance, incentiveBalance };
  }

  async _update(eventNames: HubPoolEvent[]): Promise<HubPoolUpdate> {
    const hubPoolEvents = this.hubPoolEventFilters();

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.hubPool.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.logger.warn({ at: "HubPoolClient#_update", message: "Invalid update() searchConfig.", searchConfig });
      return { success: false };
    }

    this.logger.debug({
      at: "HubPoolClient",
      message: "Updating HubPool client",
      searchConfig,
      eventNames,
    });
    const timerStart = Date.now();
    const [currentTime, pendingRootBundleProposal, ...events] = await Promise.all([
      this.hubPool.getCurrentTime({ blockTag: searchConfig.toBlock }),
      this.hubPool.rootBundleProposal({ blockTag: searchConfig.toBlock }),
      ...eventNames.map((eventName) => paginatedEventQuery(this.hubPool, hubPoolEvents[eventName], searchConfig)),
    ]);
    this.logger.debug({
      at: "HubPoolClient#_update",
      message: `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`,
    });

    const _events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, events[idx]]));

    return {
      success: true,
      currentTime,
      pendingRootBundleProposal,
      searchEndBlock: searchConfig.toBlock,
      events: _events,
    };
  }

  async update(eventsToQuery?: HubPoolEvent[]): Promise<void> {
    if (!this.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    }

    eventsToQuery = eventsToQuery ?? (Object.keys(this.hubPoolEventFilters()) as HubPoolEvent[]); // Query all events by default.

    const update = await this._update(eventsToQuery);
    if (!update.success) {
      // This failure only occurs if the RPC searchConfig is miscomputed, and has only been seen in the hardhat test
      // environment. Normal failures will throw instead. This is therefore an unfortunate workaround until we can
      // understand why we see this in test. @todo: Resolve.
      return;
    }
    const { events, currentTime, pendingRootBundleProposal, searchEndBlock } = update;

    for (const event of events["CrossChainContractsSet"]) {
      const args = spreadEventWithBlockNumber(event) as CrossChainContractsSet;
      assign(
        this.crossChainContracts,
        [args.l2ChainId],
        [
          {
            spokePool: args.spokePool,
            blockNumber: args.blockNumber,
            transactionIndex: args.transactionIndex,
            logIndex: args.logIndex,
          },
        ]
      );
    }

    for (const event of events["SetPoolRebalanceRoute"]) {
      const args = spreadEventWithBlockNumber(event) as SetPoolRebalanceRoot;
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
      assign(
        this.l1TokensToDestinationTokensWithBlock,
        [args.l1Token, args.destinationChainId],
        [
          {
            l1Token: args.l1Token,
            l2Token: args.destinationToken,
            blockNumber: args.blockNumber,
            transactionIndex: args.transactionIndex,
            logIndex: args.logIndex,
          },
        ]
      );
    }

    // For each enabled Lp token fetch the token symbol and decimals from the token contract. Note this logic will
    // only run iff a new token has been enabled. Will only append iff the info is not there already.
    // Filter out any duplicate addresses. This might happen due to enabling, disabling and re-enabling a token.
    const uniqueL1Tokens = [
      ...Array.from(
        new Set(events["L1TokenEnabledForLiquidityProvision"].map((event) => spreadEvent(event.args).l1Token))
      ),
    ];
    const [tokenInfo, lpTokenInfo] = await Promise.all([
      Promise.all(uniqueL1Tokens.map((l1Token: string) => fetchTokenInfo(l1Token, this.hubPool.provider))),
      Promise.all(
        uniqueL1Tokens.map(
          async (l1Token: string) => await this.hubPool.pooledTokens(l1Token, { blockTag: update.searchEndBlock })
        )
      ),
    ]);
    for (const info of tokenInfo) {
      if (!this.l1Tokens.find((token) => token.symbol === info.symbol)) {
        if (info.decimals > 0 && info.decimals <= 18) {
          this.l1Tokens.push(info);
        } else {
          throw new Error(`Unsupported HubPool token: ${JSON.stringify(info)}`);
        }
      }
    }

    uniqueL1Tokens.forEach((token: string, i) => {
      this.lpTokens[token] = { lastLpFeeUpdate: lpTokenInfo[i].lastLpFeeUpdate };
    });

    this.proposedRootBundles.push(
      ...events["ProposeRootBundle"]
        .filter((event) => !this.configOverride.ignoredHubProposedBundles.includes(event.blockNumber))
        .map((event) => {
          return { ...spreadEventWithBlockNumber(event), transactionHash: event.transactionHash } as ProposedRootBundle;
        })
    );
    this.canceledRootBundles.push(
      ...events["RootBundleCanceled"].map((event) => spreadEventWithBlockNumber(event) as CancelledRootBundle)
    );
    this.disputedRootBundles.push(
      ...events["RootBundleDisputed"].map((event) => spreadEventWithBlockNumber(event) as DisputedRootBundle)
    );

    for (const event of events["RootBundleExecuted"]) {
      if (this.configOverride.ignoredHubExecutedBundles.includes(event.blockNumber)) {
        continue;
      }

      // Set running balances and incentive balances for this bundle.
      const executedRootBundle = spreadEventWithBlockNumber(event) as ExecutedRootBundle;
      const { l1Tokens, runningBalances } = executedRootBundle;
      const nTokens = l1Tokens.length;

      // Safeguard
      if (![nTokens, nTokens * 2].includes(runningBalances.length)) {
        throw new Error(
          `Invalid runningBalances length: ${runningBalances.length}. Expected ${nTokens} or ${nTokens * 2} for chain ${
            this.chainId
          } transaction ${event.transactionHash}`
        );
      }
      executedRootBundle.runningBalances = runningBalances.slice(0, nTokens);
      executedRootBundle.incentiveBalances =
        runningBalances.length > nTokens ? runningBalances.slice(nTokens) : runningBalances.map(() => toBN(0));
      this.executedRootBundles.push(executedRootBundle);
    }

    // If the contract's current rootBundleProposal() value has an unclaimedPoolRebalanceLeafCount > 0, then
    // it means that either the root bundle proposal is in the challenge period and can be disputed, or it has
    // passed the challenge period and pool rebalance leaves can be executed. Once all leaves are executed, the
    // unclaimed count will drop to 0 and at that point there is nothing more that we can do with this root bundle
    // besides proposing another one.
    if (pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount > 0) {
      const mostRecentProposedRootBundle = this.proposedRootBundles[this.proposedRootBundles.length - 1];
      this.pendingRootBundle = {
        poolRebalanceRoot: pendingRootBundleProposal.poolRebalanceRoot,
        relayerRefundRoot: pendingRootBundleProposal.relayerRefundRoot,
        slowRelayRoot: pendingRootBundleProposal.slowRelayRoot,
        proposer: pendingRootBundleProposal.proposer,
        unclaimedPoolRebalanceLeafCount: pendingRootBundleProposal.unclaimedPoolRebalanceLeafCount,
        challengePeriodEndTimestamp: pendingRootBundleProposal.challengePeriodEndTimestamp,
        bundleEvaluationBlockNumbers: mostRecentProposedRootBundle.bundleEvaluationBlockNumbers.map(
          (block: BigNumber) => {
            // Ideally, the HubPool.sol contract should limit the size of the elements within the
            // bundleEvaluationBlockNumbers array. But because it doesn't, we wrap the cast of BN --> Number
            // in a try/catch statement and return some value that would always be disputable.
            // This catches the denial of service attack vector where a malicious proposer proposes with bundle block
            // evaluation block numbers larger than what BigNumber::toNumber() can handle.
            try {
              return block.toNumber();
            } catch {
              return 0;
            }
          }
        ),
        proposalBlockNumber: mostRecentProposedRootBundle.blockNumber,
      };
    } else {
      this.pendingRootBundle = undefined;
    }

    this.currentTime = currentTime;
    this.latestBlockSearched = searchEndBlock;
    this.firstBlockToSearch = update.searchEndBlock + 1; // Next iteration should start off from where this one ended.
    this.eventSearchConfig.toBlock = undefined; // Caller can re-set on subsequent updates if necessary.

    this.isUpdated = true;
    this.logger.debug({ at: "HubPoolClient::update", message: "HubPool client updated!", searchEndBlock });
  }

  // Returns end block for `chainId` in ProposedRootBundle.bundleBlockEvalNumbers. Looks up chainId
  // in chainId list, gets the index where its located, and returns the value of the index in
  // bundleBlockEvalNumbers. Returns 0 if `chainId` can't be found in `chainIdList` and if index doesn't
  // exist in bundleBlockEvalNumbers.
  protected getBundleEndBlockForChain(
    proposeRootBundleEvent: ProposedRootBundle,
    chainId: number,
    chainIdList: number[]
  ): number {
    const bundleEvaluationBlockNumbers: BigNumber[] = proposeRootBundleEvent.bundleEvaluationBlockNumbers;
    const chainIdIndex = chainIdList.indexOf(chainId);
    if (chainIdIndex === -1) {
      return 0;
    }
    // Sometimes, the root bundle event's chain ID list will update from bundle to bundle, so we need to check that
    // the bundle evaluation block number list is long enough to contain this index. We assume that chain ID's
    // are only added to the bundle block list, never deleted.
    if (chainIdIndex >= bundleEvaluationBlockNumbers.length) {
      return 0;
    }
    return bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
  }
}
