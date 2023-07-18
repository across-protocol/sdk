import assert from "assert";
import { BigNumber } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import UBAFeeConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import { filterAsync, mapAsync } from "../../utils/ArrayUtils";
import { SpokePoolClients } from "../../utils/TypeUtils";
import { isDefined } from "../../utils/TypeGuards";
import { sortEventsAscending } from "../../utils/EventUtils";
import { toBN } from "../../utils/common";
import { getTokenSymbolForFlow, validateFillForDeposit } from "../../utils/FlowUtils";
import { ERC20__factory } from "../../typechain";
import {
  ModifiedUBAFlow,
  RequestValidReturnType,
  UBABundleState,
  UBAChainState,
  UBAClientState,
} from "./UBAClientTypes";
import {
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  TokenRunningBalance,
  UbaFlow,
  isUbaInflow,
} from "../../interfaces";
import { Logger } from "winston";
import { analog } from "../../UBAFeeCalculator";
import { CHAIN_ID_LIST_INDICES } from "../../constants";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
} from "../../utils/BundleUtils";
import { SpokePoolClient } from "../SpokePoolClient";

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
  const ubaConfig = configClient.getUBAConfig(l1TokenInfo?.address, blockNumber);
  if (ubaConfig === undefined) {
    throw new Error(`UBA config for blockTag ${blockNumber} not found`);
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
): { proposalBlock: number; start: number; end: number }[] {
  let toBlock = hubPoolBlock;

  // Reconstruct bundle ranges based on published end blocks.
  const bundleData: { start: number; end: number; proposalBlock: number }[] = [];
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
      proposalBlock: latestExecutedRootBundle.blockNumber,
      start: blockRangeForChain[0],
      end: blockRangeForChain[1],
    });

    // Decrement toBlock to the start of the most recently grabbed bundle.
    toBlock = latestExecutedRootBundle.blockNumber;
  }

  return bundleData;
}

/**
 * Resolves the corresponding deposit for a fill. Unlike in the Pre UBA clients, this function does NOT
 * fall back to querying fresh RPC events to try to find a fill. Instead, if the deposit can't be found
 * then this code will just crash, protecting the caller's funds. This is because if we were to find an old
 * deposit, we'd need to recompute its expected realizedLpFeePct, which would be based on the deposit balancing
 * fee and therefore requires more information from the flows preceding it. This is a future TODO.
 * @param fill The fill to resolve the corresponding deposit for
 * @param spokePoolClients The spoke clients to query for the deposit
 * @returns The corresponding deposit for the fill, or undefined if the deposit was not found
 */
export async function resolveCorrespondingDepositForFill(
  fill: FillWithBlock,
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient
): Promise<DepositWithBlock | undefined> {
  // Matched deposit for fill was not found in spoke client. This situation should be rare so let's
  // send some extra RPC requests to blocks older than the spoke client's initial event search config
  // to find the deposit if it exists.
  return queryHistoricalDepositForFill(hubPoolClient, spokePoolClients, fill);
}

// TODO: Unit test this
/**
 * Return the flow with all associated fees so that caller can validate an arbitrary flow at a point intime.
 * This can be used to validate a deposit that is much older than spoke pool client's lookback.
 * @param flow
 * @bundlesToLoad The number of bundle states to load to validate the flow data. This should always be greater than 0.
 * We'll always load the bundle directly preceding the flow since we need that at a minimum to get the running balance
 * of the flow. Loading more bundles adds additional assurance that we'll be able to validate all flows in the
 * bundle preceding the flow, for example when validating deposits that are older than a fill.
 */
export async function getModifiedFlow(
  chainId: number,
  flow: UbaFlow,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  bundlesToLoad = 3
): Promise<ModifiedUBAFlow> {
  const tokenSymbol = getTokenSymbolForFlow(flow, chainId, hubPoolClient);
  if (!tokenSymbol) {
    throw new Error(`Could not find token symbol for chain ${chainId} and flow ${JSON.stringify(flow)}`);
  }

  // Load bundle ranges before flow and until after it:
  const bundleRanges = Object.fromEntries(
    Object.keys(spokePoolClients).map((_chainId) => {
      const bundles = getMostRecentBundleBlockRanges(
        Number(_chainId),
        bundlesToLoad,
        flow.quoteBlockNumber,
        hubPoolClient,
        spokePoolClients
      );
      // Make bundle.end cover from the block range until the flow.block so we know the running balance right before
      // the flow
      bundles[bundles.length - 1].end = flow.blockNumber;
      return [_chainId, bundles];
    })
  );

  // Instantiate new spoke pool clients that will look back at older data:
  const newSpokePoolClients = Object.fromEntries(
    await mapAsync(Object.keys(spokePoolClients), async (_chainId) => {
      const spokeChain = Number(_chainId);
      // Span spoke pool client event searches from oldest bundle's start to newest bundle's end:
      const spokePoolClientSearchSettings = {
        fromBlock: bundleRanges[spokeChain][0].start,
        toBlock: bundleRanges[spokeChain][bundleRanges[spokeChain].length - 1].end,
        maxBlockLookBack: spokePoolClients[spokeChain].eventSearchConfig.maxBlockLookBack,
      };
      const newSpokeClient = new SpokePoolClient(
        spokePoolClients[chainId].logger,
        spokePoolClients[chainId].spokePool,
        hubPoolClient,
        Number(_chainId),
        spokePoolClients[chainId].deploymentBlock,
        spokePoolClientSearchSettings
      );
      await newSpokeClient.update();

      return [chainId, newSpokeClient];
    })
  );

  // Now, load flow data only for the chainId of the flow we care about. The spoke pool clients should have set
  // their event search settings old enough to validate all flows in this bundle.
  const bundleRangeBeforeFlow = bundleRanges[chainId][bundleRanges[chainId].length - 1];
  const bundleData = (
    await getFlowDataForBundle(
      hubPoolClient,
      newSpokePoolClients,
      bundleRangeBeforeFlow.start,
      bundleRangeBeforeFlow.end,
      chainId,
      [tokenSymbol],
      bundleRangeBeforeFlow.proposalBlock
    )
  )[0];

  // Get the running balance at the time of the flow.
  if (!bundleData || bundleData.openingBlockNumberForSpokeChain > flow.blockNumber) {
    throw new Error("Couldn't find bundle with start block < flow.block");
  }
  const precedingFlows = bundleData.flows.filter((bundleFlow) => bundleFlow.flow.blockNumber <= flow.blockNumber);
  const {
    lpFee,
    relayerBalancingFee,
    depositBalancingFee,
    lastRunningBalance,
    lastIncentiveBalance,
    netRunningBalanceAdjustment,
  } = getFeesForFlow(
    flow,
    precedingFlows.map((flow) => flow.flow),
    bundleData,
    chainId,
    tokenSymbol
  );
  return {
    flow,
    systemFee: {
      systemFee: lpFee.add(depositBalancingFee),
      depositBalancingFee,
      lpFee,
    },
    relayerFee: {
      relayerBalancingFee,
    },
    runningBalance: lastRunningBalance,
    incentiveBalance: lastIncentiveBalance,
    netRunningBalanceAdjustment,
  };
}

// of a deposit older or younger than its fixed lookback.
export async function queryHistoricalDepositForFill(
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  fill: Fill
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
    return originSpokePoolClient.getDepositForFill(fill);
  }

  // At this stage, deposit is not in spoke pool client's search range. Perform an expensive, additional data query
  // to try to validate this deposit.
  const timerStart = Date.now();
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Loading historical bundle to try to find matching deposit for fill",
    fill,
  });
  const deposit: DepositWithBlock = await originSpokePoolClient.findDeposit(
    fill.depositId,
    fill.destinationChainId,
    fill.depositor
  );
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Found matching deposit candidate for fill, fetching bundle data to set fees",
    timeElapsed: Date.now() - timerStart,
    deposit,
  });
  const depositFees = await getModifiedFlow(deposit.originChainId, deposit, hubPoolClient, spokePoolClients);
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Recomputed deposit realizedLpFee",
    timeElapsed: Date.now() - timerStart,
    depositFees,
  });
  deposit.realizedLpFeePct = depositFees.systemFee.systemFee;
  return validateFillForDeposit(fill, deposit) ? deposit : undefined;
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
  maxBundleStates: number,
  _latestHubPoolBlockNumber?: number
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

  const latestHubPoolBlockNumber = _latestHubPoolBlockNumber ?? hubPoolClient.latestBlockNumber;
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
      const bundles = getMostRecentBundleBlockRanges(
        chainId,
        maxBundleStates,
        latestHubPoolBlockNumber,
        hubPoolClient,
        spokePoolClients
      );
      // Make the last bundle to cover until the last spoke client searched block
      bundles[bundles.length - 1].end = spokePoolClients[chainId].latestBlockSearched;

      // Extend the bundle range to the latest block searched by the spoke pool client. This way we can load flow
      // data for all flows that have occurred since the last validated bundle.
      if (spokePoolClient.latestBlockSearched < bundles[bundles.length - 1].end) {
        throw new Error(`Spoke pool client ${chainId} has not searched all blocks in bundle range`);
      }

      // For each bundle, load common data that we'll use for all tokens in bundle, and then load flow data
      // for each token. This is a triple loop that we run in parallel at each level:
      // 1. Loop through all bundles
      // 2. Loop through all tokens
      // 3. Loop through all flows for token in bundle
      // At the end of these three loops we'll have flow data for each token for each bundle.
      await Promise.all(
        bundles.map(async ({ end: endingBundleBlockNumber, proposalBlock, start: startingBundleBlockNumber }) => {
          const constructedBundlesForChain = await getFlowDataForBundle(
            hubPoolClient,
            spokePoolClients,
            startingBundleBlockNumber,
            endingBundleBlockNumber,
            chainId,
            relevantTokenSymbols,
            proposalBlock
          );
          constructedBundlesForChain.forEach(({ tokenSymbol, ...bundleState }) => {
            // Push the fully filled out flow data for this bundle to the list of bundle states for this token.
            if (!chainState.bundles[tokenSymbol]) chainState.bundles[tokenSymbol] = [];
            chainState.bundles[tokenSymbol].push(bundleState);
          });
        })
      );
    })
  );

  return ubaClientState;
}

export function getOpeningBalances(
  hubPoolClient: HubPoolClient,
  chainId: number,
  l1TokenAddress: string,
  hubPoolBlock: number
): TokenRunningBalance {
  const precedingValidatedBundle = hubPoolClient.getLatestFullyExecutedRootBundle(hubPoolBlock);
  if (!precedingValidatedBundle) {
    throw new Error(`No validated bundle found for bundle proposed before ${hubPoolBlock}`);
  }
  const executedLeafForChain = hubPoolClient
    .getExecutedLeavesForRootBundle(precedingValidatedBundle, hubPoolBlock)
    .find((leaf) => leaf.chainId === chainId);
  if (!executedLeafForChain) {
    throw new Error(
      `No executed leaf found for chain ${chainId} in root bundle proposed at ${precedingValidatedBundle.transactionHash}`
    );
  }
  return hubPoolClient.getRunningBalanceForToken(l1TokenAddress, executedLeafForChain);
}
export async function getFlowDataForBundle(
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  startingBundleBlockNumber: number,
  endingBundleBlockNumber: number,
  chainId: number,
  relevantTokenSymbols: string[],
  bundleProposalBlock: number
): Promise<(UBABundleState & { tokenSymbol: string })[]> {
  // For performance reasons, grab all flows for bundle up front. This way we don't need to traverse internal
  // spoke pool client event arrays multiple times for each token.
  // These flows are assumed to be sorted in ascending order.
  const recentFlows = await getFlows(
    chainId,
    spokePoolClients,
    hubPoolClient,
    startingBundleBlockNumber,
    endingBundleBlockNumber
  );

  // These values are the same for each token for this bundle, so cache them.
  let ubaConfigForBundle: UBAFeeConfig;
  const constructedBundles = await Promise.all(
    relevantTokenSymbols.map(async (tokenSymbol) => {
      const l1TokenInfo = hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol);
      if (!l1TokenInfo) {
        throw new Error(`No L1 token address mapped to symbol ${tokenSymbol}`);
      }
      const l1TokenAddress = l1TokenInfo.address;

      // Get the block number and opening balance for this token. We do this by looking up the last validated
      // bundle before latestHubPoolBlockNumber. We do that by looking up executed leaves for that validated bundle
      // which must have occurred before the bundleProposalTime. Using that executed leaf data we can pull
      // out the running balances snapshotted before the bundleProposalBlock
      const { runningBalance, incentiveBalance } = getOpeningBalances(
        hubPoolClient,
        chainId,
        l1TokenAddress,
        bundleProposalBlock
      );

      // Load the config set at the start of this bundle. We assume that all flows will be charged
      // fees using this same config. Any configuration update changes that occurred during this
      // bundle range will apply to the following bundle.
      ubaConfigForBundle = getUBAFeeConfig(hubPoolClient, chainId, tokenSymbol, startingBundleBlockNumber);
      // Construct the bundle data for this token.
      const constructedBundle: UBABundleState & { tokenSymbol: string } = {
        flows: [],
        openingBlockNumberForSpokeChain: startingBundleBlockNumber,
        closingBlockNumberForSpokeChain: endingBundleBlockNumber,
        openingBalance: runningBalance,
        openingIncentiveBalance: incentiveBalance,
        config: ubaConfigForBundle,
        tokenSymbol,
      };

      recentFlows.forEach((flow) => {
        // Previous flows will be populated with all flows we've stored into the `constructedBundle.flows`
        // array so far. On the first `flow`, this will be an empty array.
        const previousFlows = constructedBundle.flows.map((flow) => flow.flow);
        const previousFlowsIncludingCurrent = previousFlows.concat(flow);
        const {
          lpFee,
          relayerBalancingFee,
          depositBalancingFee,
          lastRunningBalance,
          lastIncentiveBalance,
          netRunningBalanceAdjustment,
        } = getFeesForFlow(flow, previousFlowsIncludingCurrent, constructedBundle, chainId, tokenSymbol);
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
        // Hack for now: Since UBAClient is dependent on SpokePoolClient, fill in the deposit realizedLpFeePct
        // based on system fee we just computed.
        if (isUbaInflow(flow)) {
          spokePoolClients[flow.originChainId].updateDepositRealizedLpFeePct(flow, lpFee.add(depositBalancingFee));
        }
      });

      return constructedBundle;
    })
  );

  return constructedBundles;
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
      (
        await getFills(chainId, hubPoolClient, spokePoolClients, {
          fromBlock,
          toBlock,
          repaymentChainId: chainId,
          isSlowRelay: false,
        })
      ).filter((fill: FillWithBlock) => {
        // We only want to include full fills as flows. Partial fills need to request refunds and those refunds
        // will be included as flows.
        return fill.fillAmount.eq(fill.totalFilledAmount);
      })
    )
  ).filter((fill) => fill !== undefined) as UbaFlow[];

  const refundRequests: UbaFlow[] = (
    await Promise.all(
      spokePoolClient.getRefundRequests(fromBlock, toBlock).map(async (refundRequest) => {
        const result = await refundRequestIsValid(spokePoolClients, hubPoolClient, refundRequest);
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
            quoteBlockNumber: matchingDeposit.quoteBlockNumber,
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
    // If fill block is
    if (fillBlock.lt(destSpoke.eventSearchConfig.fromBlock)) {
      // TODO: We need to do a look back for a fill if we can't find it. We can't assume it doesn't exist, similar to
      // why we try to do a longer lookback below for a deposit. The problem with looking up the fill is that there is no
      // deterministic way to eliminate the possibility that a fill exists.
      // However, its OK to assume this refund is invalid for now since we assume that refunds are sent very close
      // to the time of the fill.
      // Can try to use `getModifiedFlow` in combination with some new findFill method in the SpokePoolClient.
      throw new Error("Unimplemented: refund request fillBlock is older than spoke pool client from block");
    } else {
      return { valid: false, reason: "Unable to find matching fill" };
    }
  }

  const deposit = await resolveCorrespondingDepositForFill(fill, spokePoolClients, hubPoolClient);
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
  toBlock?: number;
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
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  filter: SpokePoolFillFilter = {}
): Promise<(FillWithBlock & { quoteBlockNumber: number })[]> {
  const spokePoolClient = spokePoolClients[chainId];
  assert(isDefined(spokePoolClient));

  const { originChainId, repaymentChainId, relayer, isSlowRelay, fromBlock, toBlock } = filter;

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
        (isDefined(originChainId) && fill.originChainId !== originChainId) ||
        (isDefined(repaymentChainId) && fill.repaymentChainId !== repaymentChainId) ||
        (isDefined(relayer) && fill.relayer !== relayer) ||
        (isDefined(isSlowRelay) && fill.updatableRelayData.isSlowRelay !== isSlowRelay)
      ) {
        return undefined;
      }

      const deposit = await queryHistoricalDepositForFill(hubPoolClient, spokePoolClients, fill);
      if (deposit !== undefined) {
        return {
          ...fill,
          quoteBlockNumber: deposit.quoteBlockNumber,
        };
      } else return undefined;
    })
  ).filter(isDefined);

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

    const result = await refundRequestIsValid(spokePoolClients, hubPoolClient, refundRequest);

    return result.valid;
  });

  return refundRequests;
}
