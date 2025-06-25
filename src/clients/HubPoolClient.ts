import assert from "assert";
import { Contract, EventFilter } from "ethers";
import _ from "lodash";
import winston from "winston";
import { DEFAULT_CACHING_SAFE_LAG, DEFAULT_CACHING_TTL, TOKEN_SYMBOLS_MAP, ZERO_ADDRESS } from "../constants";
import {
  CachingMechanismInterface,
  CancelledRootBundle,
  CrossChainContractsSet,
  Deposit,
  DepositWithBlock,
  DestinationTokenWithBlock,
  DisputedRootBundle,
  ExecutedRootBundle,
  L1Token,
  Log,
  LpToken,
  PendingRootBundle,
  ProposedRootBundle,
  RealizedLpFee,
  SetPoolRebalanceRoot,
  TokenRunningBalance,
} from "../interfaces";
import * as lpFeeCalculator from "../lpFeeCalculator";
import { EVMBlockFinder } from "../arch/evm";
import {
  BigNumber,
  bnZero,
  dedupArray,
  EventSearchConfig,
  MakeOptional,
  assign,
  fetchTokenInfo,
  getCachedBlockForTimestamp,
  getCurrentTime,
  getNetworkName,
  isDefined,
  mapAsync,
  paginatedEventQuery,
  shouldCache,
  sortEventsDescending,
  spreadEventWithBlockNumber,
  toBN,
  getTokenInfo,
  getUsdcSymbol,
  compareAddressesSimple,
  chainIsSvm,
  getDeployedAddress,
  SvmAddress,
} from "../utils";
import { AcrossConfigStoreClient as ConfigStoreClient } from "./AcrossConfigStoreClient/AcrossConfigStoreClient";
import { BaseAbstractClient, isUpdateFailureReason, UpdateFailureReason } from "./BaseAbstractClient";

type HubPoolUpdateSuccess = {
  success: true;
  currentTime: number;
  pendingRootBundleProposal: PendingRootBundle;
  events: Record<string, Log[]>;
  searchEndBlock: number;
};
type HubPoolUpdateFailure = {
  success: false;
  reason: UpdateFailureReason;
};
export type HubPoolUpdate = HubPoolUpdateSuccess | HubPoolUpdateFailure;

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

export type LpFeeRequest = Pick<Deposit, "originChainId" | "inputToken" | "inputAmount" | "quoteTimestamp"> & {
  paymentChainId?: number;
};

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
  public readonly blockFinder: EVMBlockFinder;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    public configStoreClient: ConfigStoreClient,
    public deploymentBlock = 0,
    readonly chainId: number = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 },
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
    super(eventSearchConfig, cachingMechanism);
    this.latestHeightSearched = Math.min(deploymentBlock - 1, 0);
    this.firstHeightToSearch = eventSearchConfig.from;

    const provider = this.hubPool.provider;
    this.blockFinder = new EVMBlockFinder(provider);
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

  protected getL1TokenForDeposit(
    deposit: Pick<DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber">
  ): string {
    // L1-->L2 token mappings are set via PoolRebalanceRoutes which occur on mainnet,
    // so we use the latest token mapping. This way if a very old deposit is filled, the relayer can use the
    // latest L2 token mapping to find the L1 token counterpart.
    return this.getL1TokenForL2TokenAtBlock(deposit.inputToken, deposit.originChainId, deposit.quoteBlockNumber);
  }

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number): boolean {
    return this.l1TokensToDestinationTokens?.[l1Token]?.[destinationChainId] != undefined;
  }

  l2TokenEnabledForL1TokenAtBlock(l1Token: string, destinationChainId: number, hubBlockNumber: number): boolean {
    // Find the last mapping published before the target block.
    const l2Token: DestinationTokenWithBlock | undefined = sortEventsDescending(
      this.l1TokensToDestinationTokensWithBlock?.[l1Token]?.[destinationChainId] ?? []
    ).find((mapping: DestinationTokenWithBlock) => mapping.blockNumber <= hubBlockNumber);
    return l2Token !== undefined;
  }

  l2TokenHasPoolRebalanceRoute(l2Token: string, l2ChainId: number, hubPoolBlock = this.latestHeightSearched): boolean {
    return Object.values(this.l1TokensToDestinationTokensWithBlock).some((destinationTokenMapping) => {
      return Object.entries(destinationTokenMapping).some(([_l2ChainId, setPoolRebalanceRouteEvents]) => {
        return setPoolRebalanceRouteEvents.some((e) => {
          return (
            e.blockNumber <= hubPoolBlock &&
            compareAddressesSimple(e.l2Token, l2Token) &&
            Number(_l2ChainId) === l2ChainId
          );
        });
      });
    });
  }

  /**
   * @dev If tokenAddress + chain do not exist in TOKEN_SYMBOLS_MAP then this will throw.
   * @param tokenAddress Token address on `chain`
   * @param chain Chain where the `tokenAddress` exists in TOKEN_SYMBOLS_MAP.
   * @returns Token info for the given token address on the L2 chain including symbol and decimal.
   */
  getTokenInfoForAddress(tokenAddress: string, chain: number): L1Token {
    const tokenInfo = getTokenInfo(tokenAddress, chain);
    // @dev Temporarily handle case where an L2 token for chain ID can map to more than one TOKEN_SYMBOLS_MAP
    // entry. For example, L2 Bridged USDC maps to both the USDC and USDC.e/USDbC entries in TOKEN_SYMBOLS_MAP.
    if (tokenInfo.symbol.toLowerCase() === "usdc" && chain !== this.chainId) {
      tokenInfo.symbol = getUsdcSymbol(tokenAddress, chain) ?? "UNKNOWN";
    }
    return tokenInfo;
  }

  /**
   * Resolve a given timestamp to a block number on the HubPool chain.
   * @param timestamp A single timestamp to be resolved to a block number on the HubPool chain.
   * @returns The block number corresponding to the supplied timestamp.
   */
  getBlockNumber(timestamp: number): Promise<number> {
    const hints = { lowBlock: this.deploymentBlock };
    return getCachedBlockForTimestamp(this.chainId, timestamp, this.blockFinder, this.cachingMechanism, hints);
  }

  /**
   * For an array of timestamps, resolve each unique timestamp to a block number on the HubPool chain.
   * @dev Inputs are filtered for uniqueness and sorted to improve BlockFinder efficiency.
   * @dev Querying block numbers sequentially also improves BlockFinder efficiency.
   * @param timestamps Array of timestamps to be resolved to a block number on the HubPool chain.
   * @returns A mapping of quoteTimestamp -> HubPool block number.
   */
  async getBlockNumbers(timestamps: number[]): Promise<{ [quoteTimestamp: number]: number }> {
    const sortedTimestamps = dedupArray(timestamps).sort((x, y) => x - y);
    const blockNumbers: { [quoteTimestamp: number]: number } = {};
    for (const timestamp of sortedTimestamps) {
      blockNumbers[timestamp] = await this.getBlockNumber(timestamp);
    }

    return blockNumbers;
  }

  async getCurrentPoolUtilization(l1Token: string): Promise<BigNumber> {
    const blockNumber = this.latestHeightSearched ?? (await this.hubPool.provider.getBlockNumber());
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

  async batchComputeRealizedLpFeePct(deposits: LpFeeRequest[]): Promise<RealizedLpFee[]> {
    assert(deposits.length > 0, "No deposits supplied to batchComputeRealizedLpFeePct");
    if (!isDefined(this.currentTime)) {
      throw new Error("HubPoolClient has not set a currentTime");
    }

    // Map each HubPool token to an array of unqiue quoteTimestamps.
    const utilizationTimestamps: { [hubPoolToken: string]: number[] } = {};

    // Map each HubPool token to utilization at a particular block number.
    let utilization: { [hubPoolToken: string]: { [blockNumber: number]: BigNumber } } = {};

    let quoteBlocks: { [quoteTimestamp: number]: number } = {};

    // Map SpokePool token addresses to HubPool token addresses.
    // Note: Should only be accessed via `getHubPoolToken()` or `getHubPoolTokens()`.
    const hubPoolTokens: { [k: string]: string } = {};
    const getHubPoolToken = (deposit: LpFeeRequest, quoteBlockNumber: number): string | undefined => {
      const tokenKey = `${deposit.originChainId}-${deposit.inputToken}`;
      if (this.l2TokenHasPoolRebalanceRoute(deposit.inputToken, deposit.originChainId, quoteBlockNumber)) {
        return (hubPoolTokens[tokenKey] ??= this.getL1TokenForDeposit({ ...deposit, quoteBlockNumber }));
      } else return undefined;
    };
    const getHubPoolTokens = (): string[] => dedupArray(Object.values(hubPoolTokens).filter(isDefined));

    // Helper to resolve the unqiue hubPoolToken & quoteTimestamp mappings.
    const resolveUniqueQuoteTimestamps = (deposit: LpFeeRequest): void => {
      const { quoteTimestamp } = deposit;

      // Resolve the HubPool token address for this origin chainId/token pair, if it isn't already known.
      const quoteBlockNumber = quoteBlocks[quoteTimestamp];
      const hubPoolToken = getHubPoolToken(deposit, quoteBlockNumber);
      if (!hubPoolToken) {
        return;
      }

      // Append the quoteTimestamp for this HubPool token, if it isn't already enqueued.
      utilizationTimestamps[hubPoolToken] ??= [];
      if (!utilizationTimestamps[hubPoolToken].includes(quoteTimestamp)) {
        utilizationTimestamps[hubPoolToken].push(quoteTimestamp);
      }
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
    const computeRealizedLpFeePct = async (deposit: LpFeeRequest) => {
      const { originChainId, paymentChainId, inputAmount, quoteTimestamp } = deposit;
      const quoteBlock = quoteBlocks[quoteTimestamp];

      if (paymentChainId === undefined || paymentChainId === originChainId) {
        return { quoteBlock, realizedLpFeePct: bnZero };
      }

      const hubPoolToken = getHubPoolToken(deposit, quoteBlock);
      if (hubPoolToken === undefined) {
        throw new Error(
          `Cannot computeRealizedLpFeePct for deposit with no pool rebalance route for input token ${deposit.inputToken} on ${originChainId}`
        );
      }
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

    // Filter all deposits for unique quoteTimestamps, to be resolved to a blockNumber in parallel.
    const quoteTimestamps = dedupArray(deposits.map(({ quoteTimestamp }) => quoteTimestamp));
    quoteBlocks = await this.getBlockNumbers(quoteTimestamps);

    // Identify the unique hubPoolToken & quoteTimestamp mappings. This is used to optimise subsequent HubPool queries.
    deposits.forEach((deposit) => resolveUniqueQuoteTimestamps(deposit));

    // For each token / quoteBlock pair, resolve the utilisation for each quoted block.
    // This can be reused for each deposit with the same HubPool token and quoteTimestamp pair.
    utilization = Object.fromEntries(
      await mapAsync(getHubPoolTokens(), async (hubPoolToken) => [hubPoolToken, await resolveUtilization(hubPoolToken)])
    );

    // For each deposit, compute the post-relay HubPool utilisation independently.
    // @dev The caller expects to receive an array in the same length and ordering as the input `deposits`.
    return await mapAsync(deposits, async (deposit) => {
      const quoteBlock = quoteBlocks[deposit.quoteTimestamp];
      if (this.l2TokenHasPoolRebalanceRoute(deposit.inputToken, deposit.originChainId, quoteBlock)) {
        return await computeRealizedLpFeePct(deposit);
      } else {
        return {
          quoteBlock,
          realizedLpFeePct: bnZero,
        };
      }
    });
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

  areTokensEquivalent(
    tokenA: string,
    chainIdA: number,
    tokenB: string,
    chainIdB: number,
    hubPoolBlock = this.latestHeightSearched
  ): boolean {
    if (
      !this.l2TokenHasPoolRebalanceRoute(tokenA, chainIdA, hubPoolBlock) ||
      !this.l2TokenHasPoolRebalanceRoute(tokenB, chainIdB, hubPoolBlock)
    ) {
      return false;
    }
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

  /**
   * Retrieves token mappings that were modified within a specified block range.
   * @param startingBlock - The starting block of the range (inclusive).
   * @param endingBlock - The ending block of the range (inclusive).
   * @returns An array of destination tokens, each containing the `l2ChainId`, that
   *          were modified within the given block range.
   */
  getTokenMappingsModifiedInBlockRange(
    startingBlock: number,
    endingBlock: number
  ): (DestinationTokenWithBlock & { l2ChainId: number })[] {
    // This function iterates over `l1TokensToDestinationTokensWithBlock`, a nested
    // structure of L1 tokens mapped to destination chain IDs, each containing lists
    // of destination tokens with associated block numbers.
    return (
      Object.values(this.l1TokensToDestinationTokensWithBlock)
        .flatMap((destinationTokens) =>
          // Map through destination chain IDs and their associated tokens
          Object.entries(destinationTokens).flatMap(([destinationChainId, tokensWithBlock]) =>
            // Map the tokens to add the l2ChainId field for each token
            tokensWithBlock.map((token) => ({
              ...token,
              l2ChainId: Number(destinationChainId),
            }))
          )
        )
        // Filter out tokens whose blockNumber is outside the block range
        .filter((token) => token.blockNumber >= startingBlock && token.blockNumber <= endingBlock)
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
    if (!this.latestHeightSearched) {
      throw new Error("HubPoolClient::getNthFullyExecutedRootBundle client not updated");
    }

    let bundleToReturn: ProposedRootBundle | undefined;

    // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
    // executed bundle.
    if (n < 0) {
      let nextLatestMainnetBlock = startBlock ?? this.latestHeightSearched;
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
        bundleToReturn = this.getEarliestFullyExecutedRootBundle(this.latestHeightSearched, nextStartBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Add 1 so that next `getEarliestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is < nextStartBlock.
        nextStartBlock = Math.min(bundleBlockNumber + 1, this.latestHeightSearched);
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

  getLatestExecutedRootBundleContainingL1Token(
    block: number,
    chain: number,
    l1Token: string
  ): ExecutedRootBundle | undefined {
    // Search ExecutedRootBundles in descending block order to find the most recent event before the target block.
    return sortEventsDescending(this.executedRootBundles).find((executedLeaf: ExecutedRootBundle) => {
      return (
        executedLeaf.blockNumber <= block &&
        executedLeaf.chainId === chain &&
        executedLeaf.l1Tokens.some((token) => token.toLowerCase() === l1Token.toLowerCase())
      );
    });
  }

  getRunningBalanceBeforeBlockForChain(block: number, chain: number, l1Token: string): TokenRunningBalance {
    const executedRootBundle = this.getLatestExecutedRootBundleContainingL1Token(block, chain, l1Token);

    return this.getRunningBalanceForToken(l1Token, executedRootBundle);
  }

  public getRunningBalanceForToken(
    l1Token: string,
    executedRootBundle: ExecutedRootBundle | undefined
  ): TokenRunningBalance {
    let runningBalance = toBN(0);
    if (executedRootBundle) {
      const indexOfL1Token = executedRootBundle.l1Tokens
        .map((l1Token) => l1Token.toLowerCase())
        .indexOf(l1Token.toLowerCase());
      runningBalance = executedRootBundle.runningBalances[indexOfL1Token];
    }

    return { runningBalance };
  }

  async _update(eventNames: HubPoolEvent[]): Promise<HubPoolUpdate> {
    const hubPoolEvents = this.hubPoolEventFilters();
    const searchConfig = await this.updateSearchConfig(this.hubPool.provider);

    if (isUpdateFailureReason(searchConfig)) {
      return { success: false, reason: searchConfig };
    }

    const supportedEvents = Object.keys(hubPoolEvents);
    if (eventNames.some((eventName) => !supportedEvents.includes(eventName))) {
      return { success: false, reason: UpdateFailureReason.BadRequest };
    }

    const eventSearchConfigs = eventNames.map((eventName) => {
      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `searchConfig` passed in during
      // instantiation. However, certain events generally must be queried back to HubPool genesis.
      const overrideEvents = ["CrossChainContractsSet", "L1TokenEnabledForLiquidityProvision", "SetPoolRebalanceRoute"];
      if (overrideEvents.includes(eventName) && !this.isUpdated) {
        _searchConfig.from = this.deploymentBlock;
      }

      return {
        eventName,
        filter: hubPoolEvents[eventName],
        searchConfig: _searchConfig,
      };
    });

    this.logger.debug({
      at: "HubPoolClient",
      message: "Updating HubPool client",
      searchConfig: eventSearchConfigs.map(({ eventName, searchConfig }) => ({ eventName, searchConfig })),
    });
    const timerStart = Date.now();

    const { hubPool } = this;
    const multicallFunctions = ["getCurrentTime", "rootBundleProposal"];
    const [multicallOutput, ...events] = await Promise.all([
      hubPool.callStatic.multicall(
        multicallFunctions.map((f) => hubPool.interface.encodeFunctionData(f)),
        { blockTag: searchConfig.to }
      ),
      ...eventSearchConfigs.map((config) => paginatedEventQuery(hubPool, config.filter, config.searchConfig)),
    ]);

    const [currentTime, pendingRootBundleProposal] = multicallFunctions.map((fn, idx) => {
      const output = hubPool.interface.decodeFunctionResult(fn, multicallOutput[idx]);
      return output.length > 1 ? output : output[0];
    });

    this.logger.debug({
      at: "HubPoolClient#_update",
      message: `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`,
    });

    const _events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, events[idx]]));

    return {
      success: true,
      currentTime,
      pendingRootBundleProposal,
      searchEndBlock: searchConfig.to,
      events: _events,
    };
  }

  async update(
    eventsToQuery: HubPoolEvent[] = Object.keys(this.hubPoolEventFilters()) as HubPoolEvent[]
  ): Promise<void> {
    if (!this.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    }
    const update = await this._update(eventsToQuery);
    if (!update.success) {
      if (update.reason !== UpdateFailureReason.AlreadyUpdated) {
        throw new Error(`Unable to update HubPoolClient: ${update.reason}`);
      }

      // No need to touch `this.isUpdated` because it should already be set from a previous update.
      return;
    }
    const { events, currentTime, pendingRootBundleProposal, searchEndBlock } = update;

    if (eventsToQuery.includes("CrossChainContractsSet")) {
      for (const event of events["CrossChainContractsSet"]) {
        const args = spreadEventWithBlockNumber(event) as CrossChainContractsSet;
        const dataToAdd: CrossChainContractsSet = {
          spokePool: args.spokePool,
          blockNumber: args.blockNumber,
          txnRef: args.txnRef,
          logIndex: args.logIndex,
          txnIndex: args.txnIndex,
          l2ChainId: args.l2ChainId,
        };
        // If the chain is SVM then our `args.spokePool` will be set to the `solanaSpokePool.toAddressUnchecked()` in the
        // hubpool event because our hub deals with `address` types and not byte32. Therefore, we should confirm that the
        // `args.spokePool` is the same as the `solanaSpokePool.toAddressUnchecked()`. We can derive the `solanaSpokePool`
        // address by using the `getDeployedAddress` function.
        if (chainIsSvm(args.l2ChainId)) {
          const solanaSpokePool = getDeployedAddress("SvmSpoke", args.l2ChainId);
          if (!solanaSpokePool) {
            throw new Error(`SVM spoke pool not found for chain ${args.l2ChainId}`);
          }
          const truncatedAddress = SvmAddress.from(solanaSpokePool).truncateToBytes20();
          // Verify the event address matches our expected truncated address
          if (args.spokePool.toLowerCase() !== truncatedAddress.toLowerCase()) {
            throw new Error(
              `SVM spoke pool address mismatch for chain ${args.l2ChainId}. ` +
                `Expected ${truncatedAddress}, got ${args.spokePool}`
            );
          }
          // Store the full Solana address
          dataToAdd.spokePool = SvmAddress.from(solanaSpokePool).toBytes32();
        }
        assign(this.crossChainContracts, [args.l2ChainId], [dataToAdd]);
      }
    }

    if (eventsToQuery.includes("SetPoolRebalanceRoute")) {
      for (const event of events["SetPoolRebalanceRoute"]) {
        const args = spreadEventWithBlockNumber(event) as SetPoolRebalanceRoot;

        // If the destination chain is SVM, then we need to convert the destination token to the Solana address.
        // This is because the HubPool contract only holds a truncated address for the USDC token and currently
        // only supports USDC as a destination token for Solana.
        let destinationToken = args.destinationToken;
        if (chainIsSvm(args.destinationChainId)) {
          const usdcTokenSol = TOKEN_SYMBOLS_MAP.USDC.addresses[args.destinationChainId];
          const truncatedAddress = SvmAddress.from(usdcTokenSol).truncateToBytes20();
          if (destinationToken.toLowerCase() !== truncatedAddress.toLowerCase()) {
            throw new Error(
              `SVM USDC address mismatch for chain ${args.destinationChainId}. ` +
                `Expected ${truncatedAddress}, got ${destinationToken}`
            );
          }
          destinationToken = SvmAddress.from(usdcTokenSol).toBytes32();
        }

        // If the destination token is set to the zero address in an event, then this means Across should no longer
        // rebalance to this chain.
        if (destinationToken !== ZERO_ADDRESS) {
          assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], destinationToken);
          assign(
            this.l1TokensToDestinationTokensWithBlock,
            [args.l1Token, args.destinationChainId],
            [
              {
                l1Token: args.l1Token,
                l2Token: destinationToken,
                blockNumber: args.blockNumber,
                txnIndex: args.txnIndex,
                logIndex: args.logIndex,
                txnRef: args.txnRef,
              },
            ]
          );
        }
      }
    }

    // For each enabled Lp token fetch the token symbol and decimals from the token contract. Note this logic will
    // only run iff a new token has been enabled. Will only append iff the info is not there already.
    // Filter out any duplicate addresses. This might happen due to enabling, disabling and re-enabling a token.
    if (eventsToQuery.includes("L1TokenEnabledForLiquidityProvision")) {
      const uniqueL1Tokens = dedupArray(
        events["L1TokenEnabledForLiquidityProvision"].map((event) => String(event.args["l1Token"]))
      );

      const [tokenInfo, lpTokenInfo] = await Promise.all([
        Promise.all(uniqueL1Tokens.map((l1Token: string) => fetchTokenInfo(l1Token, this.hubPool.provider))),
        Promise.all(
          uniqueL1Tokens.map(
            async (l1Token: string) => await this.hubPool.pooledTokens(l1Token, { blockTag: update.searchEndBlock })
          )
        ),
      ]);
      for (const info of tokenInfo) {
        if (!this.l1Tokens.find((token) => compareAddressesSimple(token.address, info.address))) {
          if (info.decimals > 0 && info.decimals <= 18) {
            this.l1Tokens.push(info);
          } else {
            throw new Error(`Unsupported HubPool token: ${JSON.stringify(info)}`);
          }
        }
      }

      uniqueL1Tokens.forEach((token: string, i) => {
        this.lpTokens[token] = {
          lastLpFeeUpdate: lpTokenInfo[i].lastLpFeeUpdate,
          liquidReserves: lpTokenInfo[i].liquidReserves,
        };
      });
    }

    if (eventsToQuery.includes("ProposeRootBundle")) {
      this.proposedRootBundles.push(
        ...events["ProposeRootBundle"]
          .filter((event) => !this.configOverride.ignoredHubProposedBundles.includes(event.blockNumber))
          .map((event) => spreadEventWithBlockNumber(event) as ProposedRootBundle)
      );
    }

    if (eventsToQuery.includes("RootBundleCanceled")) {
      this.canceledRootBundles.push(
        ...events["RootBundleCanceled"].map((event) => spreadEventWithBlockNumber(event) as CancelledRootBundle)
      );
    }

    if (eventsToQuery.includes("RootBundleDisputed")) {
      this.disputedRootBundles.push(
        ...events["RootBundleDisputed"].map((event) => spreadEventWithBlockNumber(event) as DisputedRootBundle)
      );
    }

    if (eventsToQuery.includes("RootBundleExecuted")) {
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
            `Invalid runningBalances length: ${runningBalances.length}.` +
              ` Expected ${nTokens} or ${nTokens * 2} for chain ${this.chainId} transaction ${event.transactionHash}`
          );
        }
        executedRootBundle.runningBalances = runningBalances.slice(0, nTokens);
        this.executedRootBundles.push(executedRootBundle);
      }
    }

    // If the contract's current rootBundleProposal() value has an unclaimedPoolRebalanceLeafCount > 0, then
    // it means that either the root bundle proposal is in the challenge period and can be disputed, or it has
    // passed the challenge period and pool rebalance leaves can be executed. Once all leaves are executed, the
    // unclaimed count will drop to 0 and at that point there is nothing more that we can do with this root bundle
    // besides proposing another one.
    if (eventsToQuery.includes("ProposeRootBundle")) {
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
    }

    this.currentTime = currentTime;
    this.latestHeightSearched = searchEndBlock;
    this.firstHeightToSearch = update.searchEndBlock + 1; // Next iteration should start off from where this one ended.
    this.eventSearchConfig.to = undefined; // Caller can re-set on subsequent updates if necessary.

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
