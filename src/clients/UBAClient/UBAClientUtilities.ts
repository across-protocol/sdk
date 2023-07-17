import assert from "assert";
import { BigNumber, ethers } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import { calculateUtilizationBoundaries, computePiecewiseLinearFunction } from "../../UBAFeeCalculator/UBAFeeUtility";
import UBAFeeConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import {
  SpokePoolClients,
  filterAsync,
  isDefined,
  max,
  queryHistoricalDepositForFill,
  resolveCorrespondingDepositForFill,
  sortEventsAscending,
  toBN,
} from "../../utils";
import { ERC20__factory } from "../../typechain";
import { FlowTupleParameters } from "../../UBAFeeCalculator/UBAFeeTypes";
import { RequestValidReturnType, UBABundleState, UBAChainState, UBAClientState } from "./UBAClientTypes";
import { DepositWithBlock, FillWithBlock, ProposedRootBundle, RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { Logger } from "winston";
import { analog } from "../../UBAFeeCalculator";
import { CHAIN_ID_LIST_INDICES } from "../../constants";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
} from "../../utils/BundleUtils";

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

/**
 * Compute the realized LP fee for a given amount.
 * @param hubPoolTokenAddress The L1 token address to get the LP fee
 * @param depositChainId The chainId of the deposit
 * @param refundChainId The chainId of the refund
 * @param amount The amount that is being deposited
 * @param hubPoolClient A hubpool client instance to query the hubpool
 * @param spokePoolClients A mapping of spoke chainIds to spoke pool clients
 * @param baselineFee The baseline fee to use for this given token
 * @param gammaCutoff The gamma cutoff to use for this given token - used in the piecewise linear function calculation
 * @returns The realized LP fee for the given token on the given chainId at the given block number
 */
export async function computeLpFeeForRefresh(
  hubPoolTokenAddress: string,
  cumulativeSpokeTargets: BigNumber,
  originChainId: number,
  refundChainId: number,
  amount: BigNumber,
  hubPoolClient: HubPoolClient,
  baselineFee: BigNumber,
  gammaCutoff: FlowTupleParameters,
  hubPoolBlockNuber: number
): Promise<BigNumber> {
  const hubPoolTokenInfo = hubPoolClient.getTokenInfoForL1Token(hubPoolTokenAddress);
  if (!hubPoolTokenInfo) {
    throw new Error(`Token ${hubPoolTokenAddress} not found in hub pool client`);
  }
  const { hubBalance, hubLiquidReserves } = await getLpFeeParams(
    hubPoolBlockNuber,
    hubPoolTokenInfo.symbol,
    hubPoolClient
  );
  const tokenDecimals = hubPoolTokenInfo.decimals;
  return computeLpFeeStateful(
    amount,
    originChainId,
    refundChainId,
    hubPoolClient.chainId,
    tokenDecimals,
    hubBalance,
    hubLiquidReserves,
    cumulativeSpokeTargets,
    baselineFee,
    gammaCutoff
  );
}

/**
 * Compute the realized LP fee for a given amount. This function is stateless and does not require a hubpool client.
 * The utilization delta coming from a deposit on the originChainId plus a refund on the refundChainId is used
 * to construct the fee.
 * @param amount The amount that is being deposited
 * @param hubPoolChainId The chainId of the hub pool
 * @param decimals The number of decimals for the token
 * @param hubBalance The balance of the hub pool
 * @param hubEquity The equity of the hub pool
 * @param ethSpokeBalance The balance of the spoke pool on the mainnet spoke
 * @param spokeTargets The spoke targets for the spoke pool
 * @param baselineFee The baseline fee to use for this given token
 * @param gammaCutoff The gamma cutoff to use for this given token - used in the piecewise linear function calculation
 * @returns The realized LP fee for the given token on the given chainId at the given block number
 */
export function computeLpFeeStateful(
  amount: BigNumber,
  originChainId: number,
  refundChainId: number,
  hubPoolChainId: number,
  decimals: number,
  hubBalance: BigNumber,
  hubLiquidReserves: BigNumber,
  cumulativeSpokeTargets: BigNumber,
  baselineFee: BigNumber,
  gammaCutoff: FlowTupleParameters
) {
  if (originChainId === refundChainId) {
    throw new Error("Cannot compute LP fee for deposit where originChainId === refundChainId");
  }
  // A deposit on Ethereum raises the eth spoke balance while a refund decreases it.
  let ethSpokeDelta = ethers.constants.Zero;
  if (originChainId === hubPoolChainId) {
    ethSpokeDelta = amount;
  } else if (refundChainId === hubPoolChainId) {
    ethSpokeDelta = amount.mul(-1);
  }
  const { utilizationPostTx, utilizationPreTx } = calculateUtilizationBoundaries(
    decimals,
    hubBalance,
    hubLiquidReserves,
    ethSpokeDelta,
    cumulativeSpokeTargets
  );

  const utilizationDelta = utilizationPostTx.sub(utilizationPreTx).abs();
  const utilizationIntegral = computePiecewiseLinearFunction(gammaCutoff, utilizationPreTx, utilizationPostTx);
  return max(toBN(0), baselineFee.add(utilizationIntegral.div(utilizationDelta)));
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
  configClient: AcrossConfigStoreClient,
  chainId: number,
  l1TokenAddress: string,
  blockNumber?: number
): UBAFeeConfig {
  // If the config client has not been updated at least
  // once, throw
  if (!configClient.isUpdated) {
    throw new Error("Config client not updated");
  }
  const ubaConfig = configClient.getUBAConfig(l1TokenAddress, blockNumber);
  if (ubaConfig === undefined) {
    throw new Error(`UBA config for blockTag ${blockNumber} not found`);
  }

  const omegaDefault = ubaConfig.omega["default"];
  const omegaOverride = omitDefaultKeys(ubaConfig.omega);

  const gammaDefault = ubaConfig.gamma["default"];
  const gammaOverride = omitDefaultKeys(ubaConfig.gamma);

  const threshold = ubaConfig.rebalance[String(chainId)];

  const chainTokenCombination = `${chainId}-${l1TokenAddress}`;
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
            target: threshold.target_lower,
            threshold: threshold.threshold_lower,
          },
          upperBound: {
            target: threshold.target_upper,
            threshold: threshold.threshold_upper,
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
 * Returns most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
 * @param chainId
 * @param maxBundleStates If this is larger than available validated bundles in the HubPoolClient, will throw an error.
 * @param hubPoolBlock Only returns the most recent validated bundles proposed before this block.
 * @param hubPoolClient
 * @param spokePoolClients
 * @returns
 */
export function getMostRecentBundles(
  chainId: number,
  maxBundleStates: number,
  hubPoolBlock: number,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients
): { bundle: ProposedRootBundle; start: number; end: number }[] {
  let toBlock = hubPoolBlock;

  // Reconstruct bundle ranges based on published end blocks.
  const bundleData: { start: number; end: number; bundle: ProposedRootBundle }[] = [];
  for (let i = 0; i < maxBundleStates; i++) {
    // Get the most recent bundle end range for this chain published in a bundle before `toBlock`.
    const latestExecutedRootBundle = hubPoolClient.getNthFullyExecutedRootBundle(-1, toBlock);
    if (!latestExecutedRootBundle) {
      throw new Error(`No validated root bundle found before hubpool block ${toBlock}`);
    }
    const rootBundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      hubPoolClient.configStoreClient,
      latestExecutedRootBundle
    );
    // Make sure our spoke pool clients have the block ranges we need to look up data in this bundle range:
    if (blockRangesAreInvalidForSpokeClients(spokePoolClients, rootBundleBlockRanges)) {
      throw new Error(
        `Spoke pool clients do not have the block ranges necessary to look up data for bundle proposed at block ${
          latestExecutedRootBundle.blockNumber
        }: ${JSON.stringify(rootBundleBlockRanges)}`
      );
    }
    const blockRangeForChain = getBlockRangeForChain(rootBundleBlockRanges, chainId);

    // Push the structure to the start of the list
    bundleData.unshift({
      bundle: latestExecutedRootBundle,
      start: blockRangeForChain[0],
      end: blockRangeForChain[1],
    });

    // Decrement toBlock to the start of the most recently grabbed bundle.
    toBlock = latestExecutedRootBundle.blockNumber;
  }

  return bundleData;
}
/**
 * Load validated bundle states. Returns the most recent `maxBundleStates` # of bundles.
 * @param hubPoolClient
 * @param spokePoolClients
 * @param relevantChainIds
 * @param relevantTokenSymbols
 * @param latestHubPoolBlockNumber
 * @param updateInternalClients
 * @param relayFeeCalculatorConfig
 * @param maxBundleStates
 * @returns
 */
export async function updateUBAClient(
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  relevantChainIds: number[],
  relevantTokenSymbols: string[],
  updateInternalClients = true,
  maxBundleStates: number
): Promise<UBAClientState> {
  if (updateInternalClients) {
    await hubPoolClient.update();
    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
  }
  relevantChainIds.forEach((chainId) => {
    if (!CHAIN_ID_LIST_INDICES.includes(chainId)) {
      throw new Error(`Unsupported chainId ${chainId} in Across. Valid chains are ${CHAIN_ID_LIST_INDICES}`);
    }
  });

  const latestHubPoolBlockNumber = hubPoolClient.latestBlockNumber;
  if (!latestHubPoolBlockNumber) {
    throw new Error("Hub pool client not updated");
  }

  const ubaClientState: UBAClientState = {};
  await Promise.all(
    relevantChainIds.map(async (chainId) => {
      const spokePoolClient = spokePoolClients[chainId];

      const chainState: UBAChainState = {
        bundles: {},
        spokeChain: {
          deploymentBlockNumber: spokePoolClient.deploymentBlock,
          bundleEndBlockNumber: hubPoolClient.getLatestBundleEndBlockForChain(
            relevantChainIds,
            latestHubPoolBlockNumber,
            chainId
          ),
          latestBlockNumber: spokePoolClient.latestBlockNumber,
        },
      };
      ubaClientState[chainId] = chainState;

      // Grab all bundles for this chain. This logic is isolated into a function that we can unit test.
      // The bundles are returned in ascending order.
      const bundles = getMostRecentBundles(
        chainId,
        maxBundleStates,
        latestHubPoolBlockNumber,
        hubPoolClient,
        spokePoolClients
      );

      // For each bundle, load common data that we'll use for all tokens in bundle, and then load flow data
      // for each token. This is a triple loop that we run in parallel at each level:
      // 1. Loop through all bundles
      // 2. Loop through all tokens
      // 3. Loop through all flows for token in bundle
      // At the end of these three loops we'll have flow data for each token for each bundle.
      await Promise.all(
        bundles.map(async ({ end: endingBundleBlockNumber, bundle, start: startingBundleBlockNumber }) => {
          // Get the block number and opening balance for this token
          const executedLeafForChain = hubPoolClient
            .getExecutedLeavesForRootBundle(bundle, latestHubPoolBlockNumber)
            .find((leaf) => leaf.chainId === chainId);
          if (!executedLeafForChain) {
            throw new Error(
              `No executed leaf found for chain ${chainId} in root bundle proposed at ${bundle.transactionHash}`
            );
          }

          // For performance reasons, grab all flows for bundle up front. This way we don't need to traverse internal
          // spoke pool client event arrays multiple times for each token.
          // These flows are assumed to be sorted in ascending order.
          const recentFlows = await getFlows(
            chainId,
            relevantChainIds,
            spokePoolClients,
            hubPoolClient,
            startingBundleBlockNumber,
            endingBundleBlockNumber
          );

          // These values are the same for each token for this bundle, so cache them.
          let cumulativeSpokeTargets: BigNumber;
          let ubaConfigForBundle: UBAFeeConfig;
          await Promise.all(
            relevantTokenSymbols.map(async (tokenSymbol) => {
              // TODO: Replace the following code by mapping by this entire client by l1TokenAddress instead of tokenSymbol.
              const l1TokenInfo = hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol);
              if (!l1TokenInfo) {
                throw new Error(`No L1 token address mapped to symbol ${tokenSymbol}`);
              }
              const l1TokenAddress = l1TokenInfo.address;

              // Get the block number and opening balance for this token. This can be read directly from root bundle
              // data that we've already loaded.
              const { runningBalance, incentiveBalance } = hubPoolClient.getRunningBalanceForToken(
                l1TokenAddress,
                executedLeafForChain
              );

              // Grab the configured UBA target and spoke balances for all chains set at the start of this bundle.

              // Load the config set at the start of this bundle. We assume that all flows will be charged
              // fees using this same config. Any configuration update changes that occurred during this
              // bundle range will apply to the following bundle.
              ubaConfigForBundle = getUBAFeeConfig(
                hubPoolClient.configStoreClient,
                chainId,
                l1TokenAddress,
                startingBundleBlockNumber
              );
              // We will need to sum them all up for this token to compute the LP fee correctly.
              cumulativeSpokeTargets = ubaConfigForBundle.getTotalSpokeTargetBalanceForComputingLpFee(
                l1TokenInfo.symbol
              );

              // Construct the bundle data for this token.
              const constructedBundle: UBABundleState = {
                flows: [],
                openingBlockNumberForSpokeChain: startingBundleBlockNumber,
                openingBalance: runningBalance,
                openingIncentiveBalance: incentiveBalance,
                config: ubaConfigForBundle,
              };

              // TODO: Return a promise for each loop iteration and promise.all them
              await Promise.all(
                recentFlows.map(async (flow) => {
                  // Previous flows will be populated with all flows we've stored into the `constructedBundle.flows`
                  // array so far. On the first `flow`, this will be an empty array.
                  const previousFlows = constructedBundle.flows.map((flow) => flow.flow);
                  const previousFlowsIncludingCurrent = previousFlows.concat(flow);
                  const {
                    runningBalance: lastRunningBalance,
                    incentiveBalance: lastIncentiveBalance,
                    netRunningBalanceAdjustment,
                  } = analog.calculateHistoricalRunningBalance(
                    previousFlowsIncludingCurrent,
                    constructedBundle.openingBalance,
                    constructedBundle.openingIncentiveBalance,
                    chainId,
                    tokenSymbol,
                    constructedBundle.config
                  );
                  const { balancingFee: depositBalancingFee } = getDepositFee(
                    flow.amount,
                    lastRunningBalance,
                    lastIncentiveBalance,
                    chainId,
                    constructedBundle.config
                  );
                  const { balancingFee: relayerBalancingFee } = getRefundFee(
                    flow.amount,
                    lastRunningBalance,
                    lastIncentiveBalance,
                    chainId,
                    constructedBundle.config
                  );
                  const lpFee = await computeLpFeeForRefresh(
                    l1TokenAddress,
                    cumulativeSpokeTargets,
                    // @dev Assume that flow is taking refund on destination chain ID for purposes of computing the LP fee.
                    // This is encoded in the UMIP as the way to compute utilization.
                    flow.originChainId,
                    flow.destinationChainId,
                    flow.amount,
                    hubPoolClient,
                    constructedBundle.config.getBaselineFee(flow.destinationChainId, flow.originChainId),
                    constructedBundle.config.getLpGammaFunctionTuples(flow.destinationChainId),
                    flow.quoteBlockNumber
                  );
                  constructedBundle.flows.push({
                    flow,
                    runningBalance: lastRunningBalance,
                    incentiveBalance: lastIncentiveBalance,
                    netRunningBalanceAdjustment,
                    relayerFee: {
                      relayerBalancingFee,
                    },
                    systemFee: {
                      depositBalancingFee,
                      lpFee,
                      systemFee: lpFee.add(depositBalancingFee),
                    },
                  });
                })
              );

              // Push the fully filled out flow data for this bundle to the list of bundle states for this token.
              if (!chainState.bundles[tokenSymbol]) chainState.bundles[tokenSymbol] = [];
              chainState.bundles[tokenSymbol].push(constructedBundle);
            })
          );
        })
      );
    })
  );

  return ubaClientState;
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
async function getFlows(
  chainId: number,
  chainIdIndices: number[],
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient,
  fromBlock?: number,
  toBlock?: number,
  logger?: Logger
): Promise<UbaFlow[]> {
  const spokePoolClient = spokePoolClients[chainId];

  fromBlock = fromBlock ?? spokePoolClient.deploymentBlock;
  toBlock = toBlock ?? spokePoolClient.latestBlockNumber;

  // @todo: Fix these type assertions.
  const deposits: UbaFlow[] = spokePoolClient
    .getDeposits()
    .filter(
      (deposit: DepositWithBlock) =>
        deposit.blockNumber >= (fromBlock as number) && deposit.blockNumber <= (toBlock as number)
    );

  // Filter out:
  // - Fills that request refunds on a different chain.
  // - Subsequent fills after an initial partial fill.
  // - Slow fills.
  // - Fills that are considered "invalid" by the spoke pool client.
  const fills: UbaFlow[] = (
    await Promise.all(
      spokePoolClient.getFills().map(async (fill: FillWithBlock): Promise<UbaFlow | undefined> => {
        const validWithinBounds =
          fill.repaymentChainId === spokePoolClient.chainId &&
          fill.fillAmount.eq(fill.totalFilledAmount) &&
          fill.updatableRelayData.isSlowRelay === false &&
          fill.blockNumber >= (fromBlock as number) &&
          fill.blockNumber <= (toBlock as number);
        if (!validWithinBounds) {
          return undefined;
        } else {
          const matchingDeposit = await resolveCorrespondingDepositForFill(fill, spokePoolClients);
          if (matchingDeposit === undefined) {
            return undefined;
          } else {
            return {
              ...fill,
              quoteBlockNumber: matchingDeposit.quoteBlockNumber,
            };
          }
        }
      })
    )
  ).filter((fill) => fill !== undefined) as UbaFlow[];

  const refundRequests: UbaFlow[] = (
    await Promise.all(
      spokePoolClient.getRefundRequests(fromBlock, toBlock).map(async (refundRequest) => {
        const result = await refundRequestIsValid(chainIdIndices, spokePoolClients, hubPoolClient, refundRequest);
        if (!result.valid && logger !== undefined) {
          logger.info({
            at: "UBAClient::getFlows",
            message: `Excluding RefundRequest on chain ${chainId}`,
            reason: result.reason,
            refundRequest,
          });
        }

        if (result.valid) {
          const matchingDeposit = result.matchingDeposit;
          if (matchingDeposit === undefined) {
            throw new Error("refundRequestIsValid returned true but matchingDeposit is undefined");
          }
          return {
            ...refundRequest,
            quoteBlockNumber: result.matchingDeposit.quoteBlockNumber,
          };
        } else {
          return undefined;
        }
      })
    )
  ).filter((refundRequest) => refundRequest !== undefined) as UbaFlow[];

  // This is probably more expensive than we'd like... @todo: optimise.
  const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

  return flows;
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
  chainIdIndices: number[],
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient,
  refundRequest: RefundRequestWithBlock
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

  if (!chainIdIndices.includes(originChainId)) {
    return { valid: false, reason: "Invalid originChainId" };
  }

  if (!chainIdIndices.includes(destinationChainId) || destinationChainId === repaymentChainId) {
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
    return { valid: false, reason: "Unable to find matching fill" };
  }

  const deposit = await resolveCorrespondingDepositForFill(fill, spokePoolClients);
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

export type SpokePoolEventFilter = {
  originChainId?: number;
  destinationChainId?: number;
  relayer?: string;
  fromBlock?: number;
};

export type SpokePoolFillFilter = SpokePoolEventFilter & {
  repaymentChainId?: number;
  isSlowRelay?: boolean;
};

/**
 * @description Search for fills recorded by a specific SpokePool.
 * @param chainId Chain ID of the relevant SpokePoolClient instance.
 * @param spokePoolClients Set of SpokePoolClient instances, mapped by chain ID.
 * @param filter  Optional filtering criteria.
 * @returns Array of FillWithBlock events matching the chain ID and optional filtering criteria.
 */
export async function getFills(
  chainId: number,
  spokePoolClients: SpokePoolClients,
  filter: SpokePoolFillFilter = {}
): Promise<FillWithBlock[]> {
  const spokePoolClient = spokePoolClients[chainId];
  assert(isDefined(spokePoolClient));

  const { originChainId, repaymentChainId, relayer, isSlowRelay, fromBlock } = filter;

  const fills = await filterAsync(spokePoolClient.getFills(), async (fill) => {
    if (isDefined(fromBlock) && fromBlock > fill.blockNumber) {
      return false;
    }

    // @dev tsdx and old Typescript seem to prevent dynamic iteration over the filter, so evaluate the keys manually.
    if (
      (isDefined(originChainId) && fill.originChainId !== originChainId) ||
      (isDefined(repaymentChainId) && fill.repaymentChainId !== repaymentChainId) ||
      (isDefined(relayer) && fill.relayer !== relayer) ||
      (isDefined(isSlowRelay) && fill.updatableRelayData.isSlowRelay !== isSlowRelay)
    ) {
      return false;
    }

    // @dev The SDK-v2 UBAClient stores the base SpokePoolClient definition, but here we use an extended variant.
    // This will be resolved when upstreaming to SDK-v2.
    const originSpokePoolClient = spokePoolClients[fill.originChainId];
    if (!isDefined(originSpokePoolClient)) {
      return false;
    }

    const deposit = await queryHistoricalDepositForFill(originSpokePoolClient, fill);
    return isDefined(deposit);
  });

  return fills;
}

/**
 * @description Search for refund requests recorded by a specific SpokePool.
 * @param chainId Chain ID of the relevant SpokePoolClient instance.
 * @param chainIdIndices Complete set of ordered chain IDs.
 * @param hubPoolClient HubPoolClient instance.
 * @param spokePoolClients Set of SpokePoolClient instances, mapped by chain ID.
 * @param filter  Optional filtering criteria.
 * @returns Array of RefundRequestWithBlock events matching the chain ID and optional filtering criteria.
 */
export async function getRefundRequests(
  chainId: number,
  chainIdIndices: number[],
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  filter: SpokePoolEventFilter = {}
): Promise<RefundRequestWithBlock[]> {
  const spokePoolClient = spokePoolClients[chainId];
  assert(isDefined(spokePoolClient));

  const { originChainId, destinationChainId, relayer, fromBlock } = filter;

  const refundRequests = await filterAsync(spokePoolClient.getRefundRequests(), async (refundRequest) => {
    assert(refundRequest.repaymentChainId === chainId);

    if (isDefined(fromBlock) && fromBlock > refundRequest.blockNumber) {
      return false;
    }

    // @dev tsdx and old Typescript seem to prevent dynamic iteration over the filter, so evaluate the keys manually.
    if (
      (isDefined(originChainId) && refundRequest.originChainId !== originChainId) ||
      (isDefined(destinationChainId) && refundRequest.destinationChainId !== destinationChainId) ||
      (isDefined(relayer) && refundRequest.relayer !== relayer)
    ) {
      return false;
    }

    const result = await refundRequestIsValid(chainIdIndices, spokePoolClients, hubPoolClient, refundRequest);

    return result.valid;
  });

  return refundRequests;
}
