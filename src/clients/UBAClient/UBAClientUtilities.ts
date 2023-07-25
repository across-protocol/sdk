import assert from "assert";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import UBAFeeConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import { mapAsync } from "../../utils/ArrayUtils";
import { SpokePoolClients } from "../../utils/TypeUtils";
import { isDefined } from "../../utils/TypeGuards";
import { toBN } from "../../utils/common";
import { validateFillForDeposit } from "../../utils/FlowUtils";
import { ModifiedUBAFlow, RequestValidReturnType, SpokePoolFillFilter, UBAClientState } from "./UBAClientTypes";
import {
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  TokenRunningBalance,
  UBAParsedConfigType,
  UbaFlow,
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
} from "../../interfaces";
import { getBlockForChain, getBlockRangeForChain, getImpliedBundleBlockRanges } from "../../utils/BundleUtils";
import { stringifyJSONWithNumericString } from "../../utils/JSONUtils";

/**
 * Omit the default key from a dictionary
 * @param obj The dictionary to omit the default key from
 * @returns The dictionary without the default key
 * @note This is used to omit the default key from the UBA config
 */
function omitDefaultKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.keys(obj).reduce((acc, key) => {
    if (key !== "default") {
      return {
        ...acc,
        [key]: obj[key],
      };
    }
    return acc;
  }, {});
}

export function parseUBAFeeConfig(
  chainId: number,
  tokenSymbol: string,
  ubaConfig?: UBAParsedConfigType
): UBAFeeConfig | undefined {
  if (!ubaConfig) {
    return undefined;
  }

  const omegaDefault = ubaConfig.omega["default"];
  const omegaOverride = omitDefaultKeys(ubaConfig.omega);

  const gammaDefault = ubaConfig.gamma["default"];
  const gammaOverride = omitDefaultKeys(ubaConfig.gamma);

  const threshold = ubaConfig.rebalance[String(chainId)];

  const chainTokenCombination = `${chainId}-${tokenSymbol}`;
  return new UBAFeeConfig(
    {
      default: ubaConfig.alpha["default"],
      override: omitDefaultKeys(ubaConfig.alpha),
    },
    {
      default: omegaDefault,
      override: omegaOverride,
    },
    {
      default: {
        lowerBound: {
          target: toBN(0),
          threshold: toBN(0),
        },
        upperBound: {
          target: toBN(0),
          threshold: toBN(0),
        },
      },
      override: {
        [chainTokenCombination]: {
          lowerBound: {
            target: threshold?.target_lower,
            threshold: threshold?.threshold_lower,
          },
          upperBound: {
            target: threshold?.target_upper,
            threshold: threshold?.threshold_upper,
          },
        },
      },
    },
    {
      default: gammaDefault,
      override: gammaOverride,
    },
    ubaConfig.incentivePoolAdjustment,
    ubaConfig.ubaRewardMultiplier
  );
}

/**
 * Returns the UBA config for a given chainId and tokenSymbol at a given block height.
 * @param hubPoolClient The hub pool client to use for fetching the UBA config. This client's config store client must be updated.
 * @param chainId The chainId to fetch the UBA config for.
 * @param tokenSymbol The token symbol to fetch the UBA config for.
 * @param blockNumber The block height to fetch the UBA config for.
 * @returns The UBA config for the given chainId and tokenSymbol at the given block height.
 * @throws If the config store client has not been updated at least once.
 * @throws If the L1 token address cannot be found for the given token symbol.
 * @throws If the UBA config for the given block height cannot be found.
 */
export function getUBAFeeConfig(
  hubPoolClient: HubPoolClient,
  chainId: number,
  tokenSymbol: string,
  blockNumber?: number
): UBAFeeConfig {
  const configClient = hubPoolClient.configStoreClient;
  // If the config client has not been updated at least
  // once, throw
  if (!configClient.isUpdated) {
    throw new Error("Config client not updated");
  }
  const l1TokenInfo = hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol);
  if (!l1TokenInfo) {
    throw new Error("L1 token can't be found, have you updated hub pool client?");
  }
  const rawUbaConfig = configClient.getUBAConfig(l1TokenInfo?.address, blockNumber);
  const ubaConfig = parseUBAFeeConfig(chainId, tokenSymbol, rawUbaConfig);
  if (ubaConfig === undefined) {
    throw new Error(`UBA config for blockTag ${blockNumber} not found`);
  }

  // Validate omega curves:
  // - Each curve must have a zero point.
  const omegaDefaultZeroCurve = ubaConfig.getZeroFeePointOnBalancingFeeCurve(chainId);
  if (!isDefined(omegaDefaultZeroCurve)) {
    throw new Error(`Omega curve for chain ${chainId} does not have a zero point`);
  }
  return ubaConfig;
}
/**
 * Returns most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
 * Will only returns bundle ranges that are subject to UBA rules, which is based on the bundle's start block.
 * Additionally, includes potential next bundle block ranges which extend until the latest spoke pool client search
 * windows, so that the caller can call this function to cover all UBA events.
 * @param chainId
 * @param maxBundleStates If this is larger than available validated bundles in the HubPoolClient, will throw an error.
 * @param hubPoolBlock Only returns the most recent validated bundles proposed before this block.
 * @param hubPoolClient The hub pool client to use for fetching the bundle ranges.
 * @param spokePoolClients The spoke pool clients to use for fetching the bundle ranges.
 * @returns The most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
 */
export function getMostRecentBundleBlockRanges(
  chainId: number,
  maxBundleStates: number,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients
): { start: number; end: number }[] {
  let toBlock = hubPoolClient.latestBlockNumber;
  if (!isDefined(toBlock)) {
    throw new Error("HubPoolClient has undefined latestBlockNumber");
  }

  // Reconstruct bundle ranges based on published end blocks.
  const ubaActivationStartBlocks = getUbaActivationBundleStartBlocks(hubPoolClient);
  const ubaActivationHubStartBlock = getBlockForChain(
    ubaActivationStartBlocks,
    hubPoolClient.chainId,
    hubPoolClient.configStoreClient.enabledChainIds
  );

  // Bundle states are examined in chronological descending order.
  const bundleData: { start: number; end: number }[] = [];
  for (let i = 0; i < maxBundleStates; i++) {
    // Get the most recent bundle end range for this chain published in a bundle before `toBlock`.
    const latestExecutedRootBundle = hubPoolClient.getNthFullyExecutedRootBundle(-1, toBlock);
    if (!latestExecutedRootBundle) {
      break;
    }
    const rootBundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      hubPoolClient.configStoreClient,
      latestExecutedRootBundle
    );

    // If UBA is not enabled for this bundle, exit early since no subsequent bundles will be enabled
    // for the UBA, as the UBA was a non-reversible change and we're only looking older in the past from here.
    const hubPoolStartBlock = getBlockRangeForChain(
      rootBundleBlockRanges,
      hubPoolClient.chainId,
      hubPoolClient.configStoreClient.enabledChainIds
    )[0];
    if (!(hubPoolStartBlock >= ubaActivationHubStartBlock)) {
      break;
    }

    // Push the block range for this chain to the start of the list
    const blockRangeForChain = getBlockRangeForChain(
      rootBundleBlockRanges,
      chainId,
      hubPoolClient.configStoreClient.enabledChainIds
    );
    bundleData.unshift({
      start: blockRangeForChain[0],
      end: blockRangeForChain[1],
    });

    // Decrement toBlock to the start of the most recently grabbed bundle.
    toBlock = latestExecutedRootBundle.blockNumber;
  }

  // If we haven't saved any bundles yet, then
  // there probably hasn't been a bundle validated after the UBA activation block containing this chain. This is not necessarily
  // an error so inject a block range from the UBA activation block of this chain to the latest
  // spoke block searched so we can query all UBA eligible events for this chain.
  if (bundleData.length === 0) {
    const ubaActivationBundleStartBlocks = getUbaActivationBundleStartBlocks(hubPoolClient);
    const ubaActivationBundleStartBlockForChain = getBlockForChain(
      ubaActivationBundleStartBlocks,
      chainId,
      hubPoolClient.configStoreClient.enabledChainIds
    );
    bundleData.unshift({
      // Tell caller to load data for events beginning at the start of the UBA version added to the ConfigStore
      start: ubaActivationBundleStartBlockForChain,
      // We'll extend this end block if the spoke pool client for this chain is defined.
      end: ubaActivationBundleStartBlockForChain,
    });
  }

  if (isDefined(spokePoolClients[chainId])) {
    // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
    // client was provided for the chain. In this case we assume that chain is disabled.
    bundleData[bundleData.length - 1].end = spokePoolClients[chainId].latestBlockSearched;
  }

  return bundleData;
}

/**
 * Return the latest validated running balance for the given token.
 * @param eventBlock
 * @param eventChain
 * @param l1Token
 * @param hubPoolLatestBlock
 * @returns
 */
export function getOpeningRunningBalanceForEvent(
  hubPoolClient: HubPoolClient,
  eventBlock: number,
  eventChain: number,
  l1Token: string,
  hubPoolLatestBlock: number
): TokenRunningBalance {
  const enabledChains = hubPoolClient.configStoreClient.enabledChainIds;

  // First find the latest executed bundle as of `hubPoolLatestBlock`.
  const latestExecutedBundle = hubPoolClient.getNthFullyExecutedRootBundle(-1, hubPoolLatestBlock);

  // If there is no latest executed bundle, then return 0. This means that there is no
  // bundle before `hubPoolLatestBlock` containing the event block.
  if (!isDefined(latestExecutedBundle)) {
    return {
      runningBalance: ethers.constants.Zero,
      incentiveBalance: ethers.constants.Zero,
    };
  }

  // Construct the bundle's block range
  const blockRanges = getImpliedBundleBlockRanges(hubPoolClient, hubPoolClient.configStoreClient, latestExecutedBundle);

  // Now compare the eventBlock against the eventBlockRange.
  const eventBlockRange = getBlockRangeForChain(blockRanges, eventChain, enabledChains);

  // If event block is after the bundle end block, use the running balances for this bundle. We need to enforce
  // that the bundle end block is less than the event block to ensure that the running balance from this bundle
  // precedes the event block.
  if (eventBlock > eventBlockRange[1]) {
    // This can't be empty since we've already validated that this bundle is fully executed.
    const executedLeavesForBundle = hubPoolClient.getExecutedLeavesForRootBundle(
      latestExecutedBundle,
      hubPoolLatestBlock
    );
    if (executedLeavesForBundle.length === 0) {
      throw new Error("No executed leaves found for bundle");
    }
    const executedLeaf = executedLeavesForBundle.find((executedLeaf) => executedLeaf.chainId === eventChain);
    if (!executedLeaf) {
      // If no executed leaf in this bundle for the chain, then need to look for an older executed bundle.
      return getOpeningRunningBalanceForEvent(
        hubPoolClient,
        eventBlock,
        eventChain,
        l1Token,
        latestExecutedBundle.blockNumber
      );
    }
    const l1TokenIndex = executedLeaf.l1Tokens.indexOf(l1Token);
    if (l1TokenIndex === -1) {
      // If l1 token not included in this bundle, then need to look for an older executed bundle.
      return getOpeningRunningBalanceForEvent(
        hubPoolClient,
        eventBlock,
        eventChain,
        l1Token,
        latestExecutedBundle.blockNumber
      );
    }

    // Finally, we need to do a final check if the latest executed root bundle was the final pre UBA one. If so, then
    // its running balances need to be negated, because in the pre UBA world we counted "positive balances" held
    // by spoke pools as negative running balances.
    const runningBalance = executedLeaf.runningBalances[l1TokenIndex];
    const incentiveBalance = executedLeaf.incentiveBalances[l1TokenIndex];

    console.log(`Event ${eventBlock} on chain ${eventChain} is after bundle`, latestExecutedBundle);
    console.log(`Using running balance ${runningBalance.toString()} for event chain`);
    const ubaActivationStartBlocks = getUbaActivationBundleStartBlocks(hubPoolClient);
    const ubaActivationStartBlockForChain = getBlockForChain(ubaActivationStartBlocks, eventChain, enabledChains);
    if (blockRanges[0][0] < ubaActivationStartBlockForChain) {
      return {
        runningBalance: runningBalance.mul(-1),
        // Incentive balance starts at 0.
        incentiveBalance: ethers.constants.Zero,
      };
    } else {
      return {
        runningBalance,
        incentiveBalance,
      };
    }
  }

  // Event is either in the bundle or before it, look for an older executed bundle.
  return getOpeningRunningBalanceForEvent(
    hubPoolClient,
    eventBlock,
    eventChain,
    l1Token,
    latestExecutedBundle.blockNumber
  );
}

export async function getMatchedDeposit(
  spokePoolClients: SpokePoolClients,
  fill: Fill,
  fillFieldsToIgnore: string[] = []
): Promise<DepositWithBlock | undefined> {
  const originSpokePoolClient = spokePoolClients[fill.originChainId];

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!originSpokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  // If someone fills with a clearly bogus deposit ID then we can quickly mark it as invalid
  if (
    fill.depositId < originSpokePoolClient.firstDepositIdForSpokePool ||
    fill.depositId > originSpokePoolClient.lastDepositIdForSpokePool
  ) {
    return undefined;
  }

  if (
    fill.depositId >= originSpokePoolClient.earliestDepositIdQueried &&
    fill.depositId <= originSpokePoolClient.latestDepositIdQueried
  ) {
    return originSpokePoolClient.getDepositForFill(fill, fillFieldsToIgnore);
  }

  // TODO: Add Redis to reduce some of these `findDeposit` calls
  const deposit = await originSpokePoolClient.findDeposit(fill.depositId, fill.destinationChainId, fill.depositor);

  return validateFillForDeposit(fill, deposit, fillFieldsToIgnore) ? deposit : undefined;
}

export function isUBAActivatedAtBlock(hubPoolClient: HubPoolClient, block: number): boolean {
  try {
    const ubaActivationBlocks = getUbaActivationBundleStartBlocks(hubPoolClient);
    const mainnetUbaActivationStartBlock = getBlockForChain(
      ubaActivationBlocks,
      hubPoolClient.chainId,
      hubPoolClient.configStoreClient.enabledChainIds
    );
    return block >= mainnetUbaActivationStartBlock;
  } catch (err) {
    // UBA not activated yet or hub pool client not updated
    return false;
  }
}
/**
 * Returns bundle range start blocks for first bundle that UBA was activated
 * @param chainIds Chains to return start blocks for.
 * */
export function getUbaActivationBundleStartBlocks(hubPoolClient: HubPoolClient): number[] {
  const latestHubPoolBlock = hubPoolClient.latestBlockNumber;
  if (!isDefined(latestHubPoolBlock)) {
    throw new Error("HubPoolClient has undefined latestBlockNumber");
  }
  const ubaActivationBlock = hubPoolClient.configStoreClient.getUBAActivationBlock();
  if (isDefined(ubaActivationBlock)) {
    const nextValidatedBundle = hubPoolClient.getProposedRootBundles().find((bundle) => {
      if (bundle.blockNumber >= ubaActivationBlock) {
        const isValidated = hubPoolClient.isRootBundleValid(bundle, latestHubPoolBlock);
        return isValidated;
      } else {
        return false;
      }
    });
    if (isDefined(nextValidatedBundle)) {
      const bundleBlockRanges = getImpliedBundleBlockRanges(
        hubPoolClient,
        hubPoolClient.configStoreClient,
        nextValidatedBundle
      );
      const bundleStartBlocks = bundleBlockRanges.map(([startBlock]) => startBlock);
      return bundleStartBlocks;
    } else {
      // No validated bundles after UBA activation block, UBA should be activated on next bundle start blocks.
      const chainIdIndices = hubPoolClient.configStoreClient.enabledChainIds;
      const nextBundleStartBlocks = chainIdIndices.map((chainId) =>
        hubPoolClient.getNextBundleStartBlockNumber(chainIdIndices, latestHubPoolBlock, chainId)
      );
      console.log(
        "No validated bundle after UBA activation block, UBA should be activated on next bundle start blocks:",
        nextBundleStartBlocks
      );
      return nextBundleStartBlocks;
    }
  } else {
    throw new Error(`UBA was not activated yet as of ${latestHubPoolBlock}`);
  }
}

/**
 * Return chain where flow occurred.
 * @param flow
 */
export function getFlowChain(flow: UbaFlow): number {
  // First let's figure out the balancing fee for the chain where the flow takes place.
  // For a deposit, the flow happens on the origin chain.
  // For a refund or fill, the flow happens on the repayment or destination chain.
  let flowChain;
  if (isUbaInflow(flow)) {
    flowChain = flow.originChainId;
  } else {
    if (outflowIsFill(flow)) {
      flowChain = flow.destinationChainId;
    } else {
      flowChain = flow.repaymentChainId;
    }
  }
  return flowChain;
}

/**
 * Retrieves the flows for a given chainId.
 * @param chainId The chainId to retrieve flows for
 * @param chainIdIndices The chainIds of the spoke pools that align with the spoke pool clients
 * @param spokePoolClients A mapping of chainIds to spoke pool clients
 * @param hubPoolClient A hub pool client instance to query the hub pool
 * @param fromBlock The block number to start retrieving flows from
 * @param toBlock The block number to stop retrieving flows from
 * @param logger A logger instance to log messages to. Optional
 * @returns The flows for the given chainId
 */
export async function getFlows(
  tokenSymbol: string,
  chainId: number,
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient,
  fromBlock?: number,
  toBlock?: number
): Promise<UbaFlow[]> {
  const spokePoolClient = spokePoolClients[chainId];

  fromBlock = fromBlock ?? spokePoolClient.eventSearchConfig.fromBlock;
  toBlock = toBlock ?? spokePoolClient.eventSearchConfig.toBlock;

  // @todo: Fix these type assertions.
  const deposits: UbaFlow[] = await mapAsync(
    spokePoolClient.getDeposits().filter((deposit: DepositWithBlock) => {
      const _tokenSymbol = hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
      return (
        _tokenSymbol === tokenSymbol &&
        deposit.blockNumber >= (fromBlock as number) &&
        deposit.blockNumber <= (toBlock as number)
      );
    }),
    async (deposit: DepositWithBlock) => {
      return {
        ...deposit,
      };
    }
  );

  // Filter out:
  // - Fills that request refunds on a different chain.
  // - Subsequent fills after an initial partial fill.
  // - Slow fills.
  // - Fills that are not complete fills.
  // - Fills that are considered "invalid" by the spoke pool client.
  const fills: UbaFlow[] = (
    await getValidFillCandidates(
      chainId,
      spokePoolClients,
      {
        fromBlock,
        toBlock,
        repaymentChainId: chainId,
        isSlowRelay: false,
        isCompleteFill: true,
      },
      ["realizedLpFeePct"]
    )
  ).filter((fill: FillWithBlock) => {
    const _tokenSymbol = hubPoolClient.getL1TokenInfoForL2Token(fill.destinationToken, fill.destinationChainId)?.symbol;
    // We only want to include full fills as flows. Partial fills need to request refunds and those refunds
    // will be included as flows.
    return _tokenSymbol === tokenSymbol && fill.fillAmount.eq(fill.totalFilledAmount);
  }) as UbaFlow[];

  const refundRequests: UbaFlow[] = (
    await getValidRefundCandidates(
      chainId,
      hubPoolClient,
      spokePoolClients,
      {
        fromBlock,
        toBlock,
      },
      ["realizedLpFeePct"]
    )
  ).filter((refundRequest: RefundRequestWithBlock) => {
    const _tokenSymbol = hubPoolClient.getL1TokenInfoForL2Token(
      refundRequest.refundToken,
      refundRequest.repaymentChainId
    )?.symbol;
    return _tokenSymbol === tokenSymbol;
  });

  // This is probably more expensive than we'd like... @todo: optimise.
  const flows = sortFlowsAscending(deposits.concat(fills).concat(refundRequests));

  return flows;
}

export function getBundleKeyForBlockRanges(blockRanges: number[][]): string {
  return JSON.stringify(blockRanges.map((blockRange) => blockRange[0]));
}
/**
 * The return value should be a number whose sign indicates the relative order of the two elements:
 * negative if a is less than b, positive if a is greater than b, and zero if they are equal.
 * @param fx
 * @param fy
 * @returns
 */
export function flowComparisonFunction(a: UbaFlow, b: UbaFlow): number {
  if (a.blockTimestamp !== b.blockTimestamp) {
    return a.blockTimestamp - b.blockTimestamp;
  }

  const quoteBlockX = isUbaInflow(a) ? a.quoteBlockNumber : a.matchedDeposit.quoteBlockNumber;
  const quoteBlockY = isUbaInflow(b) ? b.quoteBlockNumber : b.matchedDeposit.quoteBlockNumber;
  if (quoteBlockX !== quoteBlockY) {
    return quoteBlockX - quoteBlockY;
  }

  // If fx and fy have same blockTimestamp and same quote block then it gets a bit arbitrary. Whatever
  // we decide here we should push into the UMIP.
  // In the case of inflow vs outflow, return inflow first:
  if (isUbaInflow(a) && isUbaOutflow(b)) {
    return -1;
  } else if (isUbaInflow(b) && isUbaOutflow(a)) {
    return 1;
  }

  // If we get down here, then return ordered by size for now:
  const amountDiff = a.amount.sub(b.amount);
  return amountDiff.eq(0) ? 0 : amountDiff.lt(0) ? -1 : 1;
}

export function sortFlowsAscendingInPlace(flows: UbaFlow[]): UbaFlow[] {
  return flows.sort((fx, fy) => flowComparisonFunction(fx, fy));
}

export function sortFlowsAscending(flows: UbaFlow[]): UbaFlow[] {
  return sortFlowsAscendingInPlace([...flows]);
}

/**
 * Validate a refund request.
 * @param chainId The chainId of the spoke pool
 * @param chainIdIndices The chainIds of the spoke pools that align with the spoke pool clients
 * @param spokePoolClients A mapping of chainIds to spoke pool clients
 * @param hubPoolClient The hub pool client
 * @param refundRequest The refund request to validate
 * @returns Whether or not the refund request is valid
 */
export async function refundRequestIsValid(
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient,
  refundRequest: RefundRequestWithBlock,
  ignoredDepositValidationParams: string[] = []
): Promise<RequestValidReturnType> {
  const {
    relayer,
    amount,
    refundToken,
    depositId,
    originChainId,
    destinationChainId,
    repaymentChainId,
    realizedLpFeePct,
    fillBlock,
    previousIdenticalRequests,
  } = refundRequest;

  if (destinationChainId === repaymentChainId) {
    return { valid: false, reason: "Invalid destinationChainId" };
  }
  const destSpoke = spokePoolClients[destinationChainId];

  if (fillBlock.lt(destSpoke.deploymentBlock) || fillBlock.gt(destSpoke.latestBlockNumber)) {
    const { deploymentBlock, latestBlockNumber } = destSpoke;
    return {
      valid: false,
      reason: `FillBlock (${fillBlock} out of SpokePool range [${deploymentBlock}, ${latestBlockNumber}]`,
    };
  }

  // @dev: In almost all cases we should only count refunds where this value is 0. However, sometimes its possible
  // that an initial refund request is thrown out due to some odd timing bug so this might be overly restrictive.
  if (previousIdenticalRequests.gt(0)) {
    return { valid: false, reason: "Previous identical request exists" };
  }

  // Validate relayer and depositId. Also check that fill requested refund on same chain that
  // refund was sent.
  const fill = destSpoke.getFillsForRelayer(relayer).find((fill) => {
    // prettier-ignore
    return (
        fill.depositId === depositId
        && fill.originChainId === originChainId
        && fill.destinationChainId === destinationChainId
        // Must have requested refund on chain that refund was sent on.
        && fill.repaymentChainId === repaymentChainId
        // Must be a full fill to qualify for a refund.
        && fill.amount.eq(amount)
        && fill.fillAmount.eq(amount)
        && fill.realizedLpFeePct.eq(realizedLpFeePct)
        && fill.blockNumber === fillBlock.toNumber()
      );
  });
  if (!isDefined(fill)) {
    if (fillBlock.lt(destSpoke.eventSearchConfig.fromBlock)) {
      // TODO: We need to do a look back for a fill if we can't find it. We can't assume it doesn't exist, similar to
      // why we try to do a longer lookback below for a deposit. The problem with looking up the fill is that there is no
      // deterministic way to eliminate the possibility that a fill exists.
      // However, its OK to assume this refund is invalid for now since we assume that refunds are sent very close
      // to the time of the fill.
      // Can try to use `getModifiedFlow` in combination with some new findFill method in the SpokePoolClient.
      throw new Error(
        `Unimplemented: refund request fillBlock ${fillBlock} is older than spoke pool client from block, set a wider lookback`
      );
    } else {
      return { valid: false, reason: "Unable to find matching fill" };
    }
  }

  // Now, match the deposit against a fill but don't check the realizedLpFeePct parameter because it will be
  // undefined in the spoke pool client until we validate it later.
  const deposit = await getMatchedDeposit(spokePoolClients, fill, ignoredDepositValidationParams);
  if (!isDefined(deposit)) {
    return { valid: false, reason: "Unable to find matching deposit" };
  }

  // Verify that the refundToken maps to a known HubPool token and is the correct
  // token for the chain where the refund was sent from.
  // Note: the refundToken must be valid at the time the deposit was sent.
  try {
    const l1TokenForFill = hubPoolClient.getL1TokenCounterpartAtBlock(
      fill.destinationChainId,
      fill.destinationToken,
      deposit.quoteBlockNumber
    );
    const expectedRefundToken = hubPoolClient.getDestinationTokenForL1Token(l1TokenForFill, repaymentChainId);
    if (expectedRefundToken !== refundToken) {
      return { valid: false, reason: `Refund token does not map to expected refund token ${refundToken}` };
    }
  } catch {
    return { valid: false, reason: `Refund token unknown at HubPool block ${deposit.quoteBlockNumber}` };
  }

  return { valid: true, matchingFill: fill, matchingDeposit: deposit };
}

/**
 * @notice Get the matching flow in a stream of already validated flows. Useful for seeing if an outflow's
 * matched inflow `targetFlow` is in the `allValidatedFlows` list.
 * @dev Assumes `allValidatedFlows` are all validated UBA flows so there should be no duplicate
 * origin chain and deposit id combinations.
 * @param allFlows
 * @param targetFlow
 * @returns
 */
export function getMatchingFlow(
  allValidatedFlows: ModifiedUBAFlow[],
  targetFlow: UbaFlow
): ModifiedUBAFlow | undefined {
  return allValidatedFlows?.find(({ flow }) => {
    return flow.depositId === targetFlow.depositId && flow.originChainId === targetFlow.originChainId;
  });
}

/**
 * @description Search for fills recorded by a specific SpokePool. These fills are matched against deposits
 * on all fields except for `realizedLpFeePct` which isn't filled yet.
 * @param chainId Chain ID of the relevant SpokePoolClient instance.
 * @param spokePoolClients Set of SpokePoolClient instances, mapped by chain ID.
 * @param filter  Optional filtering criteria.
 * @returns Array of FillWithBlock events matching the chain ID and optional filtering criteria.
 */
export async function getValidFillCandidates(
  chainId: number,
  spokePoolClients: SpokePoolClients,
  filter: SpokePoolFillFilter = {},
  ignoredDepositValidationParams: string[] = []
): Promise<(FillWithBlock & { matchedDeposit: DepositWithBlock })[]> {
  const spokePoolClient = spokePoolClients[chainId];
  assert(isDefined(spokePoolClient));

  const { repaymentChainId, relayer, isSlowRelay, isCompleteFill, fromBlock, toBlock } = filter;

  const fills = (
    await mapAsync(spokePoolClient.getFills(), async (fill) => {
      if (isDefined(fromBlock) && fromBlock > fill.blockNumber) {
        return undefined;
      }
      if (isDefined(toBlock) && toBlock < fill.blockNumber) {
        return undefined;
      }

      // @dev tsdx and old Typescript seem to prevent dynamic iteration over the filter, so evaluate the keys manually.
      if (
        (isDefined(repaymentChainId) && fill.repaymentChainId !== repaymentChainId) ||
        (isDefined(relayer) && fill.relayer !== relayer) ||
        (isDefined(isSlowRelay) && fill.updatableRelayData.isSlowRelay !== isSlowRelay)
      ) {
        return undefined;
      }

      if (isDefined(isCompleteFill) && isCompleteFill !== fill.fillAmount.eq(fill.totalFilledAmount)) {
        return undefined;
      }

      // This deposit won't have a realizedLpFeePct field defined if its a UBA deposit, therefore match the fill
      // against all of the deposit fields except for this field which we'll fill in later.
      const deposit = await getMatchedDeposit(spokePoolClients, fill, ignoredDepositValidationParams);
      if (deposit !== undefined) {
        return {
          ...fill,
          matchedDeposit: deposit,
        };
      } else return undefined;
    })
  ).filter(isDefined);

  return fills;
}

/**
 * Search for refund requests recorded by a specific SpokePool.
 * @param chainId Chain ID of the relevant SpokePoolClient instance.
 * @param chainIdIndices Complete set of ordered chain IDs.
 * @param hubPoolClient HubPoolClient instance.
 * @param spokePoolClients Set of SpokePoolClient instances, mapped by chain ID.
 * @param filter  Optional filtering criteria.
 * @returns Array of RefundRequestWithBlock events matching the chain ID and optional filtering criteria.
 */
export async function getValidRefundCandidates(
  chainId: number,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  filter: Pick<SpokePoolFillFilter, "fromBlock" | "toBlock"> = {},
  ignoredDepositValidationParams: string[] = []
): Promise<(RefundRequestWithBlock & { matchedDeposit: DepositWithBlock })[]> {
  const spokePoolClient = spokePoolClients[chainId];
  assert(isDefined(spokePoolClient));

  const { fromBlock, toBlock } = filter;

  return (
    await mapAsync(spokePoolClient.getRefundRequests(), async (refundRequest) => {
      if (isDefined(fromBlock) && fromBlock > refundRequest.blockNumber) {
        return undefined;
      }
      if (isDefined(toBlock) && toBlock < refundRequest.blockNumber) {
        return undefined;
      }

      const result = await refundRequestIsValid(
        spokePoolClients,
        hubPoolClient,
        refundRequest,
        ignoredDepositValidationParams
      );
      if (result.valid) {
        const matchedDeposit = result.matchingDeposit;
        if (matchedDeposit === undefined) {
          throw new Error("refundRequestIsValid returned true but matchingDeposit is undefined");
        }
        return {
          ...refundRequest,
          matchedDeposit,
        };
      } else {
        return undefined;
      }
    })
  ).filter((refundRequest) => refundRequest !== undefined) as (RefundRequestWithBlock & {
    matchedDeposit: DepositWithBlock;
  })[];
}

/**
 * Serializes a `UBAClientState` object.
 * @param ubaClientState `UBAClientState` object to serialize.
 * @returns Serialized `UBAClientState` object as a string.
 * @note The resulting string can be deserialized using `deserializeUBAClientState`.
 */
export function serializeUBAClientState(ubaClientState: UBAClientState): string {
  return stringifyJSONWithNumericString(ubaClientState);
}

/**
 * @todo Improve type safety and reduce `any`s.
 * Deserializes a serialized `UBAClientState` object.
 * @param serializedUBAClientState Serialized `UBAClientState` object that for example gets returned when calling `updateUBAClient` and serializing the result.
 * @returns Deserialized `UBAClientState` object. Specifically with `{ type: "BigNumber", value: "0x0" } converted to `BigNumber` instances. And a correct `UBAFeeConfig` instance.
 */
export function deserializeUBAClientState(serializedUBAClientState: object): UBAClientState {
  return Object.entries(serializedUBAClientState).reduce((acc, [chainId, chainState]) => {
    if (typeof chainState !== "object") {
      throw new Error(`Failed to parse chain state for chain ${chainId}`);
    }

    return {
      ...acc,
      [chainId]: {
        ...chainState,
        bundles: Object.entries(chainState.bundles).reduce((acc, [tokenSymbol, bundleStates]) => {
          if (!Array.isArray(bundleStates)) {
            throw new Error(`Failed to parse bundle states for token ${tokenSymbol}`);
          }

          return {
            ...acc,
            [tokenSymbol]: bundleStates.map((bundleState) => {
              const deserializedUBAFeeConfig = deserializeUBAFeeConfig(bundleState.config);
              return {
                ...bundleState,
                openingBalance: BigNumber.from(bundleState.openingBalance),
                openingIncentiveBalance: BigNumber.from(bundleState.openingIncentiveBalance),
                config: new UBAFeeConfig(
                  deserializedUBAFeeConfig.baselineFee,
                  deserializedUBAFeeConfig.balancingFee,
                  deserializedUBAFeeConfig.balanceTriggerThreshold,
                  deserializedUBAFeeConfig.lpGammaFunction,
                  deserializedUBAFeeConfig.incentivePoolAdjustment,
                  deserializedUBAFeeConfig.ubaRewardMultiplier
                ),
                flows: bundleState.flows.map(deserializeModifiedUBAFlow),
              };
            }),
          };
        }, {}),
      },
    };
  }, {});
}

function deserializeModifiedUBAFlow(serializedModifiedUBAFlow: {
  flow: Record<string, unknown>;
  systemFee: Record<string, unknown>;
  relayerFee: Record<string, unknown>;
  runningBalance: Record<string, unknown>;
  incentiveBalance: Record<string, unknown>;
  netRunningBalanceAdjustment: Record<string, unknown>;
}) {
  return {
    flow: deserializeBigNumberValues(serializedModifiedUBAFlow.flow),
    systemFee: deserializeBigNumberValues(serializedModifiedUBAFlow.systemFee),
    relayerFee: deserializeBigNumberValues(serializedModifiedUBAFlow.relayerFee),
    runningBalance: BigNumber.from(serializedModifiedUBAFlow.runningBalance),
    incentiveBalance: BigNumber.from(serializedModifiedUBAFlow.incentiveBalance),
    netRunningBalanceAdjustment: BigNumber.from(serializedModifiedUBAFlow.netRunningBalanceAdjustment),
  };
}

function deserializeUBAFeeConfig(serializedUBAFeeConfig: {
  baselineFee: {
    default: BigNumberish;
    override: Record<string, BigNumberish>;
  };
  balancingFee: {
    default: [BigNumberish, BigNumberish][];
    override: Record<string, [BigNumberish, BigNumberish][]>;
  };
  balanceTriggerThreshold: {
    default: {
      lowerBound: {
        target?: BigNumberish;
        threshold?: BigNumberish;
      };
      upperBound: {
        target?: BigNumberish;
        threshold?: BigNumberish;
      };
    };
    override: Record<
      string,
      {
        lowerBound?: {
          target?: BigNumberish;
          threshold?: BigNumberish;
        };
        upperBound?: {
          target?: BigNumberish;
          threshold?: BigNumberish;
        };
      }
    >;
  };
  lpGammaFunction: {
    default: [BigNumberish, BigNumberish][];
    override: Record<string, [BigNumberish, BigNumberish][]>;
  };
  incentivePoolAdjustment: Record<string, BigNumber>;
  ubaRewardMultiplier: Record<string, BigNumber>;
}) {
  return {
    baselineFee: {
      default: BigNumber.from(serializedUBAFeeConfig.baselineFee.default),
      override: Object.entries(serializedUBAFeeConfig.baselineFee.override ?? {}).reduce((acc, [key, value]) => {
        acc[key] = BigNumber.from(value);
        return acc;
      }, {} as Record<string, BigNumber>),
    },
    balancingFee: {
      default: serializedUBAFeeConfig.balancingFee.default.map((tuple) =>
        tuple.map((value) => BigNumber.from(value))
      ) as [BigNumber, BigNumber][],
      override: Object.entries(serializedUBAFeeConfig.balancingFee.override ?? {}).reduce((acc, [key, value]) => {
        acc[key] = value.map((tuple) => tuple.map((value) => BigNumber.from(value))) as [BigNumber, BigNumber][];
        return acc;
      }, {} as Record<string, [BigNumber, BigNumber][]>),
    },
    balanceTriggerThreshold: {
      default: {
        lowerBound: deserializeBigNumberValues(serializedUBAFeeConfig.balanceTriggerThreshold.default.lowerBound),
        upperBound: deserializeBigNumberValues(serializedUBAFeeConfig.balanceTriggerThreshold.default.upperBound),
      },
      override: Object.entries(serializedUBAFeeConfig.balanceTriggerThreshold.override ?? {}).reduce(
        (acc, [key, value]) => {
          acc[key] = {
            lowerBound: deserializeBigNumberValues(value.lowerBound),
            upperBound: deserializeBigNumberValues(value.upperBound),
          };
          return acc;
        },
        {} as Record<
          string,
          {
            lowerBound: {
              target?: BigNumber;
              threshold?: BigNumber;
            };
            upperBound: {
              target?: BigNumber;
              threshold?: BigNumber;
            };
          }
        >
      ),
    },
    lpGammaFunction: {
      default: serializedUBAFeeConfig.lpGammaFunction.default.map((tuple) =>
        tuple.map((value) => BigNumber.from(value))
      ) as [BigNumber, BigNumber][],
      override: Object.entries(serializedUBAFeeConfig.lpGammaFunction.override ?? {}).reduce((acc, [key, value]) => {
        acc[key] = value.map((tuple) => tuple.map((value) => BigNumber.from(value))) as [BigNumber, BigNumber][];
        return acc;
      }, {} as Record<string, [BigNumber, BigNumber][]>),
    },
    incentivePoolAdjustment: Object.entries(serializedUBAFeeConfig.incentivePoolAdjustment ?? {}).reduce(
      (acc, [key, value]) => {
        acc[key] = BigNumber.from(value);
        return acc;
      },
      {} as Record<string, BigNumber>
    ),
    ubaRewardMultiplier: Object.entries(serializedUBAFeeConfig.ubaRewardMultiplier ?? {}).reduce(
      (acc, [key, value]) => {
        acc[key] = BigNumber.from(value);
        return acc;
      },
      {} as Record<string, BigNumber>
    ),
  };
}

/**
 * Serializes a `UBABundleState` object.
 * @param obj The object to deserialize.
 * @returns An object with all BigNumber values converted to strings.
 */
function deserializeBigNumberValues(obj: object = {}) {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    try {
      const parsedBigNumber = BigNumber.from(value);
      return {
        ...acc,
        [key]: parsedBigNumber,
      };
    } catch {
      // If throws then value is not a BigNumber.
      return {
        ...acc,
        [key]: value,
      };
    }
  }, {});
}
