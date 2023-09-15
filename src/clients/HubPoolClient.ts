import { Contract, BigNumber, Event, EventFilter } from "ethers";
import { Block } from "@ethersproject/abstract-provider";
import { BlockFinder } from "@uma/sdk";
import winston from "winston";
import _ from "lodash";
import {
  assign,
  EventSearchConfig,
  MakeOptional,
  BigNumberish,
  stringifyJSONWithNumericString,
  isDefined,
  getCurrentTime,
  shouldCache,
} from "../utils";
import {
  fetchTokenInfo,
  sortEventsDescending,
  spreadEvent,
  spreadEventWithBlockNumber,
  paginatedEventQuery,
  toBN,
} from "../utils";
import {
  Deposit,
  L1Token,
  CancelledRootBundle,
  DisputedRootBundle,
  LpToken,
  TokenRunningBalance,
  DepositWithBlock,
  ProposedRootBundleStringified,
  ExecutedRootBundleStringified,
  CachingMechanismInterface,
} from "../interfaces";
import { ExecutedRootBundle, PendingRootBundle, ProposedRootBundle } from "../interfaces";
import { CrossChainContractsSet, DestinationTokenWithBlock, SetPoolRebalanceRoot } from "../interfaces";
import * as lpFeeCalculator from "../lpFeeCalculator";
import { AcrossConfigStoreClient as ConfigStoreClient } from "./AcrossConfigStoreClient/AcrossConfigStoreClient";
import { BaseAbstractClient } from "./BaseAbstractClient";
import { isUBAActivatedAtBlock } from "./UBAClient/UBAClientUtilities";

type _HubPoolUpdate = {
  success: true;
  currentTime: number;
  latestBlockNumber: number;
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

  public firstBlockToSearch: number;
  public latestBlockNumber: number | undefined;
  public currentTime: number | undefined;
  public readonly blockFinder: BlockFinder<Block>;

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
    } = {
      ignoredHubExecutedBundles: [],
      ignoredHubProposedBundles: [],
    },
    cachingMechanism?: CachingMechanismInterface
  ) {
    super(cachingMechanism);
    this.latestBlockNumber = deploymentBlock === 0 ? deploymentBlock : deploymentBlock - 1;
    this.firstBlockToSearch = eventSearchConfig.fromBlock;

    const provider = this.hubPool.provider;
    this.blockFinder = new BlockFinder(provider.getBlock.bind(provider));
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

  getDestinationTokenForDeposit(deposit: {
    originChainId: number;
    originToken: string;
    destinationChainId: number;
  }): string {
    const l1Token = this.getL1TokenForDeposit(deposit);
    const destinationToken = this.getDestinationTokenForL1Token(l1Token, deposit.destinationChainId);
    if (!destinationToken) {
      this.logger.error({
        at: "HubPoolClient",
        message: "No destination token found",
        deposit,
        notificationPath: "across-error",
      });
    }
    return destinationToken;
  }

  getL1TokensToDestinationTokens(): L1TokensToDestinationTokens {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: { originChainId: number; originToken: string }): string {
    const l1Token = Object.keys(this.l1TokensToDestinationTokens).find((_l1Token) => {
      return this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId] === deposit.originToken;
    });
    if (!l1Token) {
      throw new Error(
        `Could not find L1 Token for origin chain ${deposit.originChainId} and origin token ${deposit.originToken}!`
      );
    }
    return l1Token;
  }

  getL1TokenCounterpartAtBlock(l2ChainId: number, l2Token: string, hubPoolBlock: number): string {
    const l1Token = Object.keys(this.l1TokensToDestinationTokensWithBlock).find((_l1Token) => {
      // If this token doesn't exist on this L2, return false.
      if (this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId] === undefined) {
        return false;
      }

      // Find the last mapping published before the target block.
      return sortEventsDescending(this.l1TokensToDestinationTokensWithBlock[_l1Token][l2ChainId]).find(
        (mapping: DestinationTokenWithBlock) => mapping.l2Token === l2Token && mapping.blockNumber <= hubPoolBlock
      );
    });
    if (!l1Token) {
      throw new Error(
        `Could not find L1 token mapping for chain ${l2ChainId} and L2 token ${l2Token} equal to or earlier than block ${hubPoolBlock}!`
      );
    }
    return l1Token;
  }

  getDestinationTokenForL1Token(l1Token: string, destinationChainId: number): string {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number): boolean {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId] != undefined;
  }
  getDestinationTokensToL1TokensForChainId(chainId: number): { [destinationToken: string]: L1Token } {
    return Object.fromEntries(
      this.l1Tokens
        .map((l1Token): [string, L1Token] => [this.getDestinationTokenForL1Token(l1Token.address, chainId), l1Token])
        .filter((entry) => entry[0] !== undefined)
    );
  }

  protected async getBlockNumber(timestamp: number): Promise<number | undefined> {
    return (await this.blockFinder.getBlockForTimestamp(timestamp)).number;
  }

  async getCurrentPoolUtilization(l1Token: string): Promise<BigNumberish> {
    return await this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token);
  }

  async getPostRelayPoolUtilization(
    l1Token: string,
    quoteBlockNumber: number,
    relaySize: BigNumber
  ): Promise<{
    current: BigNumber;
    post: BigNumber;
  }> {
    const overrides = { blockTag: quoteBlockNumber };
    const [current, post] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, overrides),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, relaySize, overrides),
    ]);
    return { current, post };
  }

  protected async getUtilization(
    l1Token: string,
    blockNumber: number,
    amount: BigNumber,
    timestamp: number
  ): Promise<{ current: BigNumber; post: BigNumber }> {
    // Resolve this function call as an async anonymous function
    // This way, since we have to use this call several times, we
    // only need to invoke the shorter function name.
    const resolver = async () => this.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
    // Resolve the cache locally so that we can appease typescript
    const cache = this.cachingMechanism;
    // If there is no cache, just resolve the function
    if (!cache) {
      return resolver();
    }
    // Otherwise, let's resolve the key
    const key = `utilization_${l1Token}_${blockNumber}_${amount.toString()}`;
    // Resolve the key from the cache
    const result = await cache.get<string>(key);
    // We were able to find a valid result, so let's return it
    if (isDefined(result)) {
      const [current, post] = result.split(",").map(BigNumber.from);
      return { current, post };
    }
    // We were not able to find a valid result, so let's resolve the function
    // and store the result in the cache
    else {
      const { current, post } = await resolver();
      // First determine if we should cache the result
      if (shouldCache(getCurrentTime(), timestamp, 60 * 60 * 24)) {
        // If we should cache the result, then let's store it
        await cache.set(key, `${current.toString()},${post.toString()}`, 60 * 60 * 24);
      }
      // Return the result
      return { current, post };
    }
  }

  async computeRealizedLpFeePct(
    deposit: Pick<
      DepositWithBlock,
      "quoteTimestamp" | "amount" | "destinationChainId" | "originChainId" | "blockNumber"
    >,
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber | undefined; quoteBlock: number }> {
    if (!isDefined(this.currentTime)) {
      throw new Error("HubPoolClient has not set a currentTime");
    }
    const quoteBlock = await this.getBlockNumber(deposit.quoteTimestamp);
    if (!isDefined(quoteBlock)) {
      throw new Error(`Could not find block for timestamp ${deposit.quoteTimestamp}`);
    }

    // Compare deposit block against UBA bundle start blocks.
    if (isUBAActivatedAtBlock(this, deposit.blockNumber, deposit.originChainId)) {
      // If UBA deposit then we can't compute the realizedLpFeePct until after we've updated the UBA Client.
      return {
        realizedLpFeePct: undefined,
        quoteBlock,
      };
    }

    // Otherwise, use the legacy fee model which is based ont he deposit quote block.
    const rateModel = this.configStoreClient.getRateModelForBlockNumber(
      l1Token,
      deposit.originChainId,
      deposit.destinationChainId,
      quoteBlock
    );

    const { current, post } = await this.getUtilization(l1Token, quoteBlock, deposit.amount, deposit.quoteTimestamp);
    const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(rateModel, current, post);

    return { realizedLpFeePct, quoteBlock };
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
    const l1TokenCounterpart = this.getL1TokenCounterpartAtBlock(chainId, l2Token, this.latestBlockNumber || 0);
    return this.getTokenInfoForL1Token(l1TokenCounterpart);
  }

  getTokenInfoForDeposit(deposit: Deposit): L1Token | undefined {
    return this.getTokenInfoForL1Token(this.getL1TokenForDeposit(deposit));
  }

  getTokenInfo(chainId: number | string, tokenAddress: string): L1Token | undefined {
    const deposit = { originChainId: parseInt(chainId.toString()), originToken: tokenAddress } as Deposit;
    return this.getTokenInfoForDeposit(deposit);
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
    if (!this.latestBlockNumber) {
      throw new Error("HubPoolClient::getNthFullyExecutedRootBundle client not updated");
    }

    let bundleToReturn: ProposedRootBundle | undefined;

    // If n is negative, then return the Nth latest executed bundle, otherwise return the Nth earliest
    // executed bundle.
    if (n < 0) {
      let nextLatestMainnetBlock = startBlock ?? this.latestBlockNumber;
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
        bundleToReturn = this.getEarliestFullyExecutedRootBundle(this.latestBlockNumber, nextStartBlock);
        const bundleBlockNumber = bundleToReturn ? bundleToReturn.blockNumber : 0;

        // Add 1 so that next `getEarliestFullyExecutedRootBundle` call filters out the root bundle we just found
        // because its block number is < nextStartBlock.
        nextStartBlock = Math.min(bundleBlockNumber + 1, this.latestBlockNumber);
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
    const latestBlockNumber = await this.hubPool.provider.getBlockNumber();
    const hubPoolEvents = this.hubPoolEventFilters();

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
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
      latestBlockNumber,
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
    const { events, currentTime, latestBlockNumber, pendingRootBundleProposal } = update;

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
      // Pre-UBA: runningBalances length is 1:1 with l1Tokens length. Pad incentiveBalances with zeroes.
      // Post-UBA: runningBalances array is a concatenation of pre-UBA runningBalances and incentiveBalances.
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
    this.latestBlockNumber = latestBlockNumber;
    this.firstBlockToSearch = update.searchEndBlock + 1; // Next iteration should start off from where this one ended.

    this.isUpdated = true;
    this.logger.debug({ at: "HubPoolClient::update", message: "HubPool client updated!", endBlock: latestBlockNumber });
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

  public updateFromJSON(hubPoolClientState: Partial<ReturnType<HubPoolClient["toJSON"]>>): void {
    const keysToUpdate = Object.keys(hubPoolClientState);

    this.logger.debug({
      at: "HubPoolClient",
      message: "Updating HubPool client from JSON",
      keys: keysToUpdate,
    });

    if (keysToUpdate.length === 0) {
      return;
    }

    if (!this.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    }

    const {
      l1TokensToDestinationTokens = this.l1TokensToDestinationTokens,
      l1Tokens = this.l1Tokens,
      lpTokens = this.lpTokens,
      canceledRootBundles = this.canceledRootBundles,
      disputedRootBundles = this.disputedRootBundles,
      pendingRootBundle = this.pendingRootBundle,
      crossChainContracts = this.crossChainContracts,
      l1TokensToDestinationTokensWithBlock = this.l1TokensToDestinationTokensWithBlock,
      firstBlockToSearch = this.firstBlockToSearch,
      latestBlockNumber = this.latestBlockNumber,
      currentTime = this.currentTime,
      proposedRootBundles,
      executedRootBundles,
    } = hubPoolClientState;

    this.l1TokensToDestinationTokens = l1TokensToDestinationTokens;
    this.l1Tokens = l1Tokens;
    this.lpTokens = lpTokens;
    this.proposedRootBundles = proposedRootBundles
      ? proposedRootBundles.map((bundle) => ({
          ...bundle,
          bundleEvaluationBlockNumbers: bundle.bundleEvaluationBlockNumbers.map((block) => BigNumber.from(block)),
        }))
      : this.proposedRootBundles;
    this.canceledRootBundles = canceledRootBundles;
    this.disputedRootBundles = disputedRootBundles;
    this.executedRootBundles = executedRootBundles
      ? executedRootBundles.map((bundle) => ({
          ...bundle,
          bundleLpFees: bundle.bundleLpFees.map((fee) => BigNumber.from(fee)),
          netSendAmounts: bundle.netSendAmounts.map((amount) => BigNumber.from(amount)),
          runningBalances: bundle.runningBalances.map((balance) => BigNumber.from(balance)),
          incentiveBalances: bundle.incentiveBalances.map((balance) => BigNumber.from(balance)),
        }))
      : this.executedRootBundles;
    this.pendingRootBundle = pendingRootBundle;
    this.crossChainContracts = crossChainContracts;
    this.l1TokensToDestinationTokensWithBlock = l1TokensToDestinationTokensWithBlock;
    this.firstBlockToSearch = firstBlockToSearch;
    this.latestBlockNumber = latestBlockNumber;
    this.currentTime = currentTime;
    this.isUpdated = true;
  }

  public toJSON() {
    return {
      deploymentBlock: this.deploymentBlock,
      chainId: this.chainId,
      eventSearchConfig: this.eventSearchConfig,
      configOverride: this.configOverride,

      firstBlockToSearch: this.firstBlockToSearch,
      latestBlockNumber: this.latestBlockNumber,
      currentTime: this.currentTime,

      l1TokensToDestinationTokens: this.l1TokensToDestinationTokens,
      l1Tokens: this.l1Tokens,
      lpTokens: this.lpTokens,

      proposedRootBundles: this.proposedRootBundles.map((bundle) =>
        JSON.parse(stringifyJSONWithNumericString(bundle))
      ) as ProposedRootBundleStringified[],
      canceledRootBundles: this.canceledRootBundles,
      disputedRootBundles: this.disputedRootBundles,
      executedRootBundles: this.executedRootBundles.map((bundle) =>
        JSON.parse(stringifyJSONWithNumericString(bundle))
      ) as ExecutedRootBundleStringified[],
      pendingRootBundle: this.pendingRootBundle,
      crossChainContracts: this.crossChainContracts,
      l1TokensToDestinationTokensWithBlock: this.l1TokensToDestinationTokensWithBlock,
    };
  }
}
