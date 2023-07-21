import assert from "assert";
import { BigNumber, BigNumberish } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import UBAFeeConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import { mapAsync } from "../../utils/ArrayUtils";
import { SpokePoolClients } from "../../utils/TypeUtils";
import { isDefined } from "../../utils/TypeGuards";
import { sortEventsAscending } from "../../utils/EventUtils";
import { toBN } from "../../utils/common";
import { validateFillForDeposit } from "../../utils/FlowUtils";
import { ERC20__factory } from "../../typechain";
import { RequestValidReturnType, UBABundleState, UBAClientState } from "./UBAClientTypes";
import {
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  UbaFlow,
  isUbaInflow,
  outflowIsFill,
} from "../../interfaces";
import { analog } from "../../UBAFeeCalculator";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
} from "../../utils/BundleUtils";
import { stringifyJSONWithNumericString } from "../../utils/JSONUtils";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";
import { isUBA } from "../../utils/UBAUtils";

/**
 * Returns the inputs to the LP Fee calculation for a hub pool block height. This wraps
 * the async logic needed for fetching HubPool balances and liquid reserves at a given block height.
 * @param hubPoolBlockNumber
 * @param tokenSymbol
 * @param hubPoolClient
 * @returns
 */
export async function getLpFeeParams(
  hubPoolBlockNumber: number,
  tokenSymbol: string,
  hubPoolClient: HubPoolClient
): Promise<{ hubBalance: BigNumber; hubLiquidReserves: BigNumber }> {
  if (!hubPoolClient.latestBlockNumber || hubPoolClient.latestBlockNumber < hubPoolBlockNumber) {
    throw new Error(
      `HubPool block number ${hubPoolBlockNumber} is greater than latest HubPoolClient block number ${hubPoolClient.latestBlockNumber}`
    );
  }
  const hubPoolTokenInfo = hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol);
  if (!hubPoolTokenInfo) {
    throw new Error(`No L1 token address mapped to symbol ${tokenSymbol}`);
  }
  const hubPoolTokenAddress = hubPoolTokenInfo.address;
  const erc20 = ERC20__factory.connect(hubPoolTokenAddress, hubPoolClient.hubPool.provider);
  // Grab the balances of the spoke pool and hub pool at the given block number.
  const [hubBalance, hubLiquidReserves] = await Promise.all([
    erc20.balanceOf(hubPoolClient.hubPool.address, { blockTag: hubPoolBlockNumber }),
    hubPoolClient.hubPool.pooledTokens(hubPoolTokenAddress, { blockTag: hubPoolBlockNumber }),
  ]);

  return {
    hubBalance,
    hubLiquidReserves,
  };
}

export function computeLpFeeForRefresh(baselineFee: BigNumber): BigNumber {
  return computeLpFeeStateful(baselineFee);
}

/**
 * Compute the LP fee for a given amount. This function is stateless and does not require a hubpool client.
 */
export function computeLpFeeStateful(baselineFee: BigNumber) {
  // @dev Temporarily, the LP fee only comprises the baselineFee. In the future, a variable component will be
  // added to the baseline fee that takes into account the utilized liquidity in the system and how the the bridge
  // defined by { amount, originChain, refundChain, hubPoolBlock } affects that liquidity.
  return baselineFee;
}

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

export function getUBAFeeConfig(
  hubPoolClient: HubPoolClient,
  chainId: number,
  tokenSymbol: string,
  hubBlockNumber?: number
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
  const ubaConfig = configClient.getUBAConfig(l1TokenInfo?.address, hubBlockNumber);
  if (ubaConfig === undefined) {
    throw new Error(`UBA config for blockTag ${hubBlockNumber} not found`);
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

export function getFeesForFlow(
  flow: UbaFlow,
  precedingFlowsInBundle: UbaFlow[],
  bundleState: UBABundleState,
  chainId: number,
  tokenSymbol: string
): {
  lpFee: BigNumber;
  relayerBalancingFee: BigNumber;
  depositBalancingFee: BigNumber;
  lastRunningBalance: BigNumber;
  lastIncentiveBalance: BigNumber;
  netRunningBalanceAdjustment: BigNumber;
} {
  const {
    runningBalance: lastRunningBalance,
    incentiveBalance: lastIncentiveBalance,
    netRunningBalanceAdjustment,
  } = analog.calculateHistoricalRunningBalance(
    precedingFlowsInBundle,
    bundleState.openingBalance,
    bundleState.openingIncentiveBalance,
    chainId,
    tokenSymbol,
    bundleState.config
  );
  const { balancingFee: depositBalancingFee } = getDepositFee(
    flow.amount,
    lastRunningBalance,
    lastIncentiveBalance,
    chainId,
    bundleState.config
  );
  const { balancingFee: relayerBalancingFee } = getRefundFee(
    flow.amount,
    lastRunningBalance,
    lastIncentiveBalance,
    chainId,
    bundleState.config
  );
  const lpFee = computeLpFeeForRefresh(bundleState.config.getBaselineFee(flow.destinationChainId, flow.originChainId));

  return {
    lpFee,
    relayerBalancingFee,
    depositBalancingFee,
    lastRunningBalance,
    lastIncentiveBalance,
    netRunningBalanceAdjustment,
  };
}

/**
 * Returns most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
 * Will only returns bundle ranges that are subject to UBA rules, which is based on the bundle's start block.
 * @param chainId
 * @param maxBundleStates If this is larger than available validated bundles in the HubPoolClient, will throw an error.
 * @param hubPoolBlock Only returns the most recent validated bundles proposed before this block.
 * @param hubPoolClient
 * @param spokePoolClients
 * @returns
 */
export function getMostRecentBundleBlockRanges(
  chainId: number,
  maxBundleStates: number,
  hubPoolBlock: number,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients
): { start: number; end: number }[] {
  let toBlock = hubPoolBlock;

  // Reconstruct bundle ranges based on published end blocks.

  // Bundle states are examined in chronological descending order.
  const bundleData: { start: number; end: number }[] = [];
  for (let i = 0; i < maxBundleStates; i++) {
    // Get the most recent bundle end range for this chain published in a bundle before `toBlock`.
    const latestExecutedRootBundle = hubPoolClient.getNthFullyExecutedRootBundle(-1, toBlock);
    if (!latestExecutedRootBundle) {
      // If we haven't saved any bundles yet and we're exiting early because we can't find one, then
      // there probably hasn't been a bundle validated yet containing this chain. This is not necessarily
      // an error so inject a block range from the UBA activation block of this chain to the latest
      // spoke block searched.
      if (bundleData.length === 0) {
        const ubaActivationBundleStartBlock = getUbaActivationBundleStartBlocks(hubPoolClient, [chainId])[0];
        bundleData.unshift({
          // Tell caller to load data for events beginning at the start of the UBA version added to the ConfigStore
          start: ubaActivationBundleStartBlock,
          // Load data until the latest block known.
          end: spokePoolClients[chainId].latestBlockSearched,
        });
      }
      break;
    }
    const rootBundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      hubPoolClient.configStoreClient,
      latestExecutedRootBundle
    );

    // If UBA is not enabled for this bundle, exit early since no subsequent bundles will be enabled
    // for the UBA, as the UBA was a non-reversible change.
    const hubPoolStartBlock = getBlockRangeForChain(
      rootBundleBlockRanges,
      hubPoolClient.chainId,
      hubPoolClient.configStoreClient.enabledChainIds
    )[0];
    if (!isUbaBlock(hubPoolStartBlock, hubPoolClient.configStoreClient)) {
      break;
    }

    // Make sure our spoke pool clients have the block ranges we need to look up data in this bundle range:
    if (
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        rootBundleBlockRanges,
        hubPoolClient.configStoreClient.enabledChainIds
      )
    ) {
      throw new Error(
        `Spoke pool clients do not have the block ranges necessary to look up data for bundle proposed at block ${
          latestExecutedRootBundle.blockNumber
        }: ${JSON.stringify(rootBundleBlockRanges)}`
      );
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

  return bundleData;
}

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.
export async function UBA_queryHistoricalDepositForFill(
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

  // TODO: Add Redis
  // let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
  // const redisClient = await getRedis(spokePoolClient.logger);
  // if (redisClient) {
  //   cachedDeposit = await getDeposit(getRedisDepositKey(fill), redisClient);
  // }

  // if (isDefined(cachedDeposit)) {
  //   deposit = cachedDeposit as DepositWithBlock;
  //   // Assert that cache hasn't been corrupted.
  //   assert(deposit.depositId === fill.depositId && deposit.originChainId === fill.originChainId);
  // } else {
  const deposit = await originSpokePoolClient.findDeposit(fill.depositId, fill.destinationChainId, fill.depositor);

  // if (redisClient) {
  //   await setDeposit(deposit, getCurrentTime(), redisClient, 24 * 60 * 60);
  // }
  // }

  return validateFillForDeposit(fill, deposit, fillFieldsToIgnore) ? deposit : undefined;
}

/**
 * Returns bundle range start blocks for first bundle that UBA was activated
 * @param chainIds Chains to return start blocks for.
 * */
export function getUbaActivationBundleStartBlocks(hubPoolClient: HubPoolClient, chainIds: number[]): number[] {
  const ubaActivationHubPoolBlock = getUbaActivationBlock(hubPoolClient.configStoreClient);
  const bundleStartBlocks = chainIds.map((chainId) => {
    return hubPoolClient.getBundleStartBlockContainingBlock(ubaActivationHubPoolBlock, chainId);
  });
  return bundleStartBlocks;
}

/**
 * Return first block number where UBA was activated by setting "Version" GlobalConfig in ConfigStore
 * @returns
 */
export function getUbaActivationBlock(configStoreClient: AcrossConfigStoreClient): number {
  return (
    configStoreClient.cumulativeConfigStoreVersionUpdates.find((config) => {
      isUBA(Number(config.value));
    })?.blockNumber ?? Number.MAX_SAFE_INTEGER
  );
}

export function isUbaBlock(block: number, configStoreClient: AcrossConfigStoreClient): boolean {
  const versionAppliedToDeposit = configStoreClient.getConfigStoreVersionForBlock(block);
  return isUBA(versionAppliedToDeposit);
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
  const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

  return flows;
}

export function getBundleKeyForFlow(eventBlock: number, eventChain: number, hubPoolClient: HubPoolClient): string {
  const bundleStartBlocks = hubPoolClient.getBundleStartBlocksForProposalContainingBlock(eventBlock, eventChain);
  return JSON.stringify(bundleStartBlocks);
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

  // If fx and fx have same blockTimestamp and same quote block then... FML... what do?
  const quoteBlockX = isUbaInflow(a) ? a.quoteBlockNumber : a.matchedDeposit.quoteBlockNumber;
  const quoteBlockY = isUbaInflow(b) ? b.quoteBlockNumber : b.matchedDeposit.quoteBlockNumber;
  return quoteBlockX - quoteBlockY;

  // TODO: Figure out more precise sorting algo if we get here.
}
export function sortFlowsDescendingInPlace(flows: UbaFlow[]): UbaFlow[] {
  return flows.sort((fx, fy) => flowComparisonFunction(fy, fx));
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
  const deposit = await UBA_queryHistoricalDepositForFill(spokePoolClients, fill, ignoredDepositValidationParams);
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

export type SpokePoolFillFilter = {
  relayer?: string;
  fromBlock?: number;
  toBlock?: number;
  repaymentChainId?: number;
  isSlowRelay?: boolean;
  isCompleteFill?: boolean;
};

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
      const deposit = await UBA_queryHistoricalDepositForFill(spokePoolClients, fill, ignoredDepositValidationParams);
      if (deposit !== undefined) {
        // If deposit has a realizedLpFeePct set then its a pre UBA deposit so this fill must be invalid. We assume
        // this fill is a UBA fill.
        if (isDefined(deposit.realizedLpFeePct)) {
          return undefined;
        } else {
          return {
            ...fill,
            matchedDeposit: deposit,
          };
        }
      } else return undefined;
    })
  ).filter(isDefined);

  return fills;
}

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

export function serializeUBAClientState(ubaClientState: UBAClientState): string {
  return stringifyJSONWithNumericString(ubaClientState);
}

/**
 * @todo Improve type safety and reduce `any`s.
 * @description Deserializes a serialized `UBAClientState` object.
 * @param serializedUBAClientState Serialized `UBAClientState` object that for example gets returned
 * when calling `updateUBAClient` and serializing the result.
 * @returns Deserialized `UBAClientState` object. Specifically with `{ type: "BigNumber", value: "0x0" }`
 * converted to `BigNumber` instances. And a correct `UBAFeeConfig` instance.
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
  flow: any;
  systemFee: any;
  relayerFee: any;
  runningBalance: any;
  incentiveBalance: any;
  netRunningBalanceAdjustment: any;
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
