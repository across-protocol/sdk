import assert from "assert";
import { BigNumber, BigNumberish } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import UBAFeeConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import { mapAsync } from "../../utils/ArrayUtils";
import { SpokePoolClients } from "../../utils/TypeUtils";
import { isDefined } from "../../utils/TypeGuards";
import { sortEventsAscending } from "../../utils/EventUtils";
import { toBN } from "../../utils/common";
import { getTokenSymbolForFlow, validateFillForDeposit } from "../../utils/FlowUtils";
import { ERC20__factory } from "../../typechain";
import {
  ModifiedUBAFlow,
  RequestValidReturnType,
  SpokePoolFillFilter,
  UBABundleState,
  UBAChainState,
  UBAClientState,
} from "./UBAClientTypes";
import { DepositWithBlock, Fill, FillWithBlock, RefundRequestWithBlock, UbaFlow, isUbaInflow } from "../../interfaces";
import { analog } from "../../UBAFeeCalculator";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import {
  blockRangesAreInvalidForSpokeClients,
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
} from "../../utils/BundleUtils";
import { SpokePoolClient } from "../SpokePoolClient";
import { stringifyJSONWithNumericString } from "../../utils/JSONUtils";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";
import { isUBA } from "../../utils/UBAUtils";

/**
 * Returns the inputs to the LP Fee calculation for a hub pool block height. This wraps
 * the async logic needed for fetching HubPool balances and liquid reserves at a given block height.
 * @param hubPoolBlockNumber The block height to fetch the LP fee inputs for.
 * @param tokenSymbol The token symbol to fetch the LP fee inputs for.
 * @param hubPoolClient The hub pool client to use for fetching the LP fee inputs.
 * @returns The hub balance and liquid reserves for the given token at the given block height.
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
 * Returns the LP fee for a given amount. This function is stateless and does not require a hubpool client.
 * @param baselineFee The baseline fee to use for the LP fee calculation.
 * @returns The LP fee for the given amount.
 * @note This function is essentially a wrapper around computeLpFeeStateful. It is used to compute the LP fee
 * for a given amount without needing to instantiate a hub pool client.
 */
export function computeLpFeeForRefresh(baselineFee: BigNumber): BigNumber {
  return computeLpFeeStateful(baselineFee);
}

/**
 * Compute the LP fee for a given amount. This function is stateless and does not require a hubpool client.
 * @param baselineFee The baseline fee to use for the LP fee calculation.
 * @returns The LP fee for the given amount.
 * @note This function is a wrapper around returning the baseline fee.
 */
export function computeLpFeeStateful(baselineFee: BigNumber): BigNumber {
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
 * @param chainId The chainId to get bundle ranges for.
 * @param maxBundleStates If this is larger than available validated bundles in the HubPoolClient, will throw an error.
 * @param hubPoolBlock Only returns the most recent validated bundles proposed before this block.
 * @param hubPoolClient The hub pool client to use for fetching the bundle ranges.
 * @param spokePoolClients The spoke pool clients to use for fetching the bundle ranges.
 * @returns The most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
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
        isUbaInflow(flow) ? flow.quoteBlockNumber : flow.matchedDeposit.quoteBlockNumber,
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
      [tokenSymbol]
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
  return validateFillForDeposit(fill, deposit, fillFieldsToIgnore) ? deposit : undefined;
}

/**
 * Load validated bundle states. Returns the most recent `maxBundleStates` # of bundles.
 * @param hubPoolClient The hub pool client to use for fetching the bundle ranges.
 * @param spokePoolClients The spoke pool clients to use for fetching the bundle ranges.
 * @param relevantChainIds The chainIds to load bundle states for.
 * @param relevantTokenSymbols The token symbols to load bundle states for.
 * @param updateInternalClients If true, will update the hub pool client and all spoke pool clients before loading bundle states. Defaults to true.
 * @param maxBundleStates The maximum number of bundle states to load for each chain.
 * @param latestHubPoolBlockNumber The latest block number to load bundle states for. If not provided, will use the latest block number from the hub pool client.
 * @returns All the required state to instantiate a UBAClient instance.
 * @throws If the hub pool client has not been updated at least once.
 * @throws If the hub pool client does not have a latest block number.
 * @throws If the spoke pools are out of range for the latest validated bundle.
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
  const chainIds = hubPoolClient.configStoreClient.enabledChainIds;
  relevantChainIds.forEach((chainId) => {
    if (!chainIds.includes(chainId)) {
      throw new Error(`Unsupported chainId ${chainId} in Across. Valid chains are ${chainIds}`);
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

      // TODO: We are stuck here. Given a list of bundle block ranges and functions like getFlows(chainId, tokenSymbol)
      // that return all flows for a bundle range for a chain and token, how do you validate the set of flows
      // and charge balancing fees to all of them?

      // For each bundle, load common data that we'll use for all tokens in bundle, and then load flow data
      // for each token. This is a triple loop that we run in parallel at each level:
      // 1. Loop through all bundles
      // 2. Loop through all tokens
      // 3. Loop through all flows for token in bundle
      // At the end of these three loops we'll have flow data for each token for each bundle.
      await Promise.all(
        bundles.map(async ({ end: endingBundleBlockNumber, start: startingBundleBlockNumber }) => {
          // Get bundle state data for each block range and each token for this chain.
          // Since we're going through the bundles in chronological ascending order, we
          // push to the bundle state array for each token to maintain the order.
          const constructedBundlesForChain = await getFlowDataForBundle(
            hubPoolClient,
            spokePoolClients,
            startingBundleBlockNumber,
            endingBundleBlockNumber,
            chainId,
            relevantTokenSymbols
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

/**
 * Returns true if UBA was activated at the given block number
 * @param block The block number to compare against the UBA activation block
 * @param configStoreClient The config store client to use for fetching the UBA activation block
 * @returns True if UBA was activated at the given block number
 */
export function isUbaBlock(block: number, configStoreClient: AcrossConfigStoreClient): boolean {
  const versionAppliedToDeposit = configStoreClient.getConfigStoreVersionForBlock(block);
  return isUBA(versionAppliedToDeposit);
}

/**
 * Returns the flow data for a given bundle range for a given chain and token.
 * @param hubPoolClient The hub pool client to use for fetching the bundle ranges.
 * @param spokePoolClients The spoke pool clients to use for fetching the bundle ranges.
 * @param startingBundleBlockNumber The block number to start retrieving flows from
 * @param endingBundleBlockNumber The block number to stop retrieving flows from
 * @param chainId The chainId to retrieve flows for
 * @param relevantTokenSymbols The token symbols to load bundle states for.
 * @param bundleProposalBlock The block number of the bundle proposal
 * @returns The most recent `maxBundleStates` bundle ranges for a given chain, in chronological ascending order.
 * @throw If the token symbol cannot be found.
 * @throw If the L1 token address cannot be found for the given token symbol.
 */
export async function getFlowDataForBundle(
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  startingBundleBlockNumber: number,
  endingBundleBlockNumber: number,
  chainId: number,
  relevantTokenSymbols: string[]
): Promise<(UBABundleState & { tokenSymbol: string })[]> {
  // For performance reasons, grab all flows for bundle up front. This way we don't need to traverse internal
  // spoke pool client event arrays multiple times for each token.
  // These flows are assumed to be sorted in ascending order. All deposits are assumed to be valid flows, while all
  // outflows are treated as "candidates". We need to validate them individually.
  const unvalidatedBundleFlows = await getFlows(
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
      const { runningBalance, incentiveBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        startingBundleBlockNumber,
        chainId,
        l1TokenAddress
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

      unvalidatedBundleFlows.forEach((unvalidatedFlow) => {
        // Previous flows will be populated with all flows we've stored into the `constructedBundle.flows`
        // array so far. On the first `flow`, this will be an empty array.
        const previousFlows = constructedBundle.flows.map((flow) => flow.flow);
        const previousFlowsIncludingCurrent = previousFlows.concat(unvalidatedFlow);
        const {
          lpFee,
          relayerBalancingFee,
          depositBalancingFee,
          lastRunningBalance,
          lastIncentiveBalance,
          netRunningBalanceAdjustment,
        } = getFeesForFlow(unvalidatedFlow, previousFlowsIncludingCurrent, constructedBundle, chainId, tokenSymbol);

        // If flow a deposit, then its always valid. Add it to the bundle flows.
        if (isUbaInflow(unvalidatedFlow)) {
          // Hack for now: Since UBAClient is dependent on SpokePoolClient, fill in the deposit realizedLpFeePct
          // based on system fee we just computed.
          spokePoolClients[unvalidatedFlow.originChainId].updateDepositRealizedLpFeePct(
            unvalidatedFlow,
            lpFee.add(depositBalancingFee)
          );
        }
        // If flow is a fill, then validate that its realizedLpFeePct matches its deposit's expected
        // realizedLpFeePct.
        else {
          // At this point we have either a fill that matched with a deposit on all fields besides realizedLpFeePct,
          // or a refund that matched with a fill that matched with a deposit on all fields besides realizedLpFeePct.
          // So, it now suffices to match the flow's realizedLpFeePct against the matched deposit's expected
          // realizedLpFeePct.
          const expectedRealizedLpFeePctForDeposit = depositBalancingFee.add(lpFee);
          if (!unvalidatedFlow.realizedLpFeePct.eq(expectedRealizedLpFeePctForDeposit)) {
            return;
          }
        }

        // Flow is validated, add it to constructed bundle state. This ensures that the next flow fee reconstruction
        // will have updated running balances and incentive pool sizes.
        constructedBundle.flows.push({
          flow: unvalidatedFlow,
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
  toBlock?: number
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
  // - Fills that are not complete fills.
  // - Fills that are considered "invalid" by the spoke pool client.
  const fills: UbaFlow[] = (
    await getValidFillCandidates(
      chainId,
      hubPoolClient,
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
    // We only want to include full fills as flows. Partial fills need to request refunds and those refunds
    // will be included as flows.
    return fill.fillAmount.eq(fill.totalFilledAmount);
  }) as UbaFlow[];

  const refundRequests: UbaFlow[] = await getValidRefundCandidates(
    chainId,
    hubPoolClient,
    spokePoolClients,
    {
      fromBlock,
      toBlock,
    },
    ["realizedLpFeePct"]
  );

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
      throw new Error("Unimplemented: refund request fillBlock is older than spoke pool client from block");
    } else {
      return { valid: false, reason: "Unable to find matching fill" };
    }
  }

  // Now, match the deposit against a fill but don't check the realizedLpFeePct parameter because it will be
  // undefined in the spoke pool client until we validate it later.
  const deposit = await queryHistoricalDepositForFill(
    hubPoolClient,
    spokePoolClients,
    fill,
    ignoredDepositValidationParams
  );
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
 * Search for fills recorded by a specific SpokePool. These fills are matched against deposits on all fields except for `realizedLpFeePct` which isn't filled yet.
 * @param chainId Chain ID of the relevant SpokePoolClient instance.
 * @param spokePoolClients Set of SpokePoolClient instances, mapped by chain ID.
 * @param filter  Optional filtering criteria.
 * @returns Array of FillWithBlock events matching the chain ID and optional filtering criteria.
 */
export async function getValidFillCandidates(
  chainId: number,
  hubPoolClient: HubPoolClient,
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
      const deposit = await queryHistoricalDepositForFill(
        hubPoolClient,
        spokePoolClients,
        fill,
        ignoredDepositValidationParams
      );
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
