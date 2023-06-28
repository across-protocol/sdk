import { BigNumber } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import { calculateUtilizationBoundaries, computePiecewiseLinearFunction } from "../../UBAFeeCalculator/UBAFeeUtility";
import { SpokePoolClient } from "../SpokePoolClient";
import UBAFeeConfig, { FlowTupleParameters } from "../../UBAFeeCalculator/UBAFeeConfig";
import { isDefined, max, sortEventsAscending, toBN } from "../../utils";
import { ERC20__factory } from "../../typechain";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import { RequestValidReturnType, UBABundleState, UBAChainState } from "./UBAClientTypes";
import { MAX_BUNDLE_CACHE_SIZE } from "./UBAClientConstants";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { Logger } from "winston";
import { UBAFeeSpokeCalculator } from "../../UBAFeeCalculator";

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
  depositChainId: number,
  refundChainId: number,
  amount: BigNumber,
  hubPoolClient: HubPoolClient,
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  baselineFee: BigNumber,
  gammaCutoff: FlowTupleParameters,
  blockNumber?: number
): Promise<BigNumber> {
  const configStoreClient = hubPoolClient.configStoreClient;
  const erc20 = ERC20__factory.connect(hubPoolTokenAddress, hubPoolClient.hubPool.provider);
  const [decimals, ethSpokeBalance, hubBalance, hubEquity, spokeTargets] = await Promise.all([
    erc20.decimals({ blockTag: blockNumber }),
    erc20.balanceOf(spokePoolClients[hubPoolClient.chainId].spokePool.address, { blockTag: blockNumber }),
    erc20.balanceOf(hubPoolClient.hubPool.address, { blockTag: blockNumber }),
    erc20.balanceOf(hubPoolClient.hubPool.address, { blockTag: blockNumber }),
    configStoreClient.getUBATargetSpokeBalances([depositChainId, refundChainId], hubPoolTokenAddress, blockNumber),
  ]);
  const { utilizationPostTx, utilizationPreTx } = calculateUtilizationBoundaries(
    { actionType: UBAActionType.Deposit, amount, chainId: depositChainId },
    decimals,
    hubBalance,
    hubEquity,
    ethSpokeBalance,
    spokeTargets,
    hubPoolClient.chainId
  );

  const utilizationDelta = utilizationPostTx.sub(utilizationPreTx).abs();
  const utilizationIntegral = computePiecewiseLinearFunction(gammaCutoff, utilizationPreTx, utilizationPostTx);
  return max(toBN(0), baselineFee.add(utilizationIntegral.div(utilizationDelta)));
}

// THIS IS A STUB FOR NOW
export async function getUBAFeeConfig(
  chainId: number,
  token: string,
  blockNumber: number | "latest" = "latest"
): Promise<UBAFeeConfig> {
  chainId;
  token;
  blockNumber;
  return new UBAFeeConfig(
    {
      default: toBN(0),
    },
    toBN(0),
    {
      default: [],
    },
    {},
    {
      default: [],
    }
  );
}

export async function updateUBAClient(
  hubPoolClient: HubPoolClient,
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  relevantChainIds: number[],
  relevantTokenSymbols: string[],
  hubPoolBlockNumber: number,
  updateInternalClients = true,
  currentState?: {
    [chainId: number]: UBAChainState;
  }
): Promise<{
  [chainId: number]: UBAChainState;
}> {
  if (updateInternalClients) {
    await hubPoolClient.update();
    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
  }
  const ubaChainStates: { [chainId: number]: UBAChainState } = {};

  for (const chainId of relevantChainIds) {
    const spokePoolClient = spokePoolClients[chainId];

    const chainState: UBAChainState = {
      bundles: currentState?.[chainId]?.bundles ?? {},
      spokeChain: {
        deploymentBlockNumber: spokePoolClient.deploymentBlock,
        bundleEndBlockNumber: hubPoolClient.getLatestBundleEndBlockForChain(
          relevantChainIds,
          hubPoolBlockNumber,
          chainId
        ),
        latestBlockNumber: spokePoolClient.latestBlockNumber,
      },
    };

    for (const tokenSymbol of relevantTokenSymbols) {
      // Get the bundles for this token
      const availableBundles = chainState.bundles[tokenSymbol] ?? [];
      // Get the block number and opening balance for this token
      const { blockNumber, spokePoolBalance, incentiveBalance } = getOpeningTokenBalances(
        chainId,
        tokenSymbol,
        hubPoolClient,
        hubPoolBlockNumber
      );
      // Find the bundle that has the same block number as the current block number
      const referenceBundleIndex = availableBundles.findLastIndex((bundle) => bundle.blockNumber === blockNumber);
      // Construct the bundle. If the bundle already exists, use the existing bundle
      const constructedBundle: UBABundleState = {
        ...(referenceBundleIndex !== -1 ? availableBundles[referenceBundleIndex] : { flows: [] }),
        blockNumber,
        openingBalance: spokePoolBalance,
        config: {
          ubaConfig: await getUBAFeeConfig(chainId, tokenSymbol, blockNumber),
        },
      };
      // If the bundle already exists, replace it
      if (referenceBundleIndex !== -1) {
        availableBundles[referenceBundleIndex] = constructedBundle;
      }
      // Otherwise, add it to the list of bundles
      else {
        availableBundles.push(constructedBundle);
      }
      // Find the last flow avaialble in the bundle
      const lastFlow = constructedBundle.flows[constructedBundle.flows.length - 1];
      // If the last flow exists, call getFlows with the last flow's block number as the fromBlock
      const recentFlows = getFlows(
        chainId,
        relevantChainIds,
        spokePoolClients,
        hubPoolClient,
        lastFlow?.flow.blockNumber ?? chainState.spokeChain.bundleEndBlockNumber
      );
      // Instantiate a UBAFeeSpokeCalculator
      const calculator = new UBAFeeSpokeCalculator(
        chainId,
        tokenSymbol,
        [...constructedBundle.flows.map(({ flow }) => flow), ...recentFlows],
        spokePoolBalance,
        incentiveBalance,
        constructedBundle.config.ubaConfig
      );
      for (const flow of recentFlows) {
        const { runningBalance } = calculator.calculateHistoricalRunningBalance(0, constructedBundle.flows.length);
        const { balancingFee: depositBalancingFee } = calculator.getDepositFee(flow.amount, {
          startIndex: 0,
          endIndex: constructedBundle.flows.length,
        });
        const { balancingFee: relayerBalancingFee } = calculator.getRefundFee(flow.amount, {
          startIndex: 0,
          endIndex: constructedBundle.flows.length,
        });
        const lpFee = await computeLpFeeForRefresh(
          tokenSymbol,
          flow.originChainId,
          flow.destinationChainId,
          flow.amount,
          hubPoolClient,
          spokePoolClients,
          constructedBundle.config.ubaConfig.getBaselineFee(flow.destinationChainId, flow.originChainId),
          constructedBundle.config.ubaConfig.getLpGammaFunctionTuples(flow.destinationChainId)
        );

        constructedBundle.flows.push({
          flow,
          runningBalance,
          relayerFee: {
            relayerBalancingFee,
            relayerCapitalFee: relayerBalancingFee, // TODO ASSIGN REAL VALUES
            relayerFee: relayerBalancingFee, // TODO ASSIGN REAL VALUES
            relayerGasFee: toBN(0), // TODO ASSIGN REAL VALUES
            amountTooLow: false, // TODO ASSIGN REAL VALUES
          },
          systemFee: {
            depositBalancingFee,
            lpFee,
            systemFee: lpFee.add(depositBalancingFee),
          },
        });
      }
      // Verify that there is less than MAX_BUNDLE_CACHE_SIZE bundles in the cache
      // If there are more, remove the oldest bundle
      if (availableBundles.length > MAX_BUNDLE_CACHE_SIZE) {
        availableBundles.shift();
      }
      // Set the bundles for this token
      chainState.bundles[tokenSymbol] = availableBundles;
    }
    ubaChainStates[chainId] = chainState;
  }
  // Return the updated chain states
  return ubaChainStates;
}

function getOpeningTokenBalances(
  chainId: number,
  spokePoolTokenAddress: string,
  hubPoolClient: HubPoolClient,
  hubPoolBlockNumber?: number
): { blockNumber: number; spokePoolBalance: BigNumber; incentiveBalance: BigNumber } {
  if (!isDefined(hubPoolBlockNumber)) {
    if (!isDefined(hubPoolClient.latestBlockNumber)) {
      throw new Error("Could not resolve latest block number for hub pool client");
    }
    hubPoolBlockNumber = hubPoolClient.latestBlockNumber;
  }
  const hubPoolToken = hubPoolClient.getL1TokenCounterpartAtBlock(chainId, spokePoolTokenAddress, hubPoolBlockNumber);
  if (!isDefined(hubPoolToken)) {
    throw new Error(`Could not resolve ${chainId} token ${spokePoolTokenAddress} at block ${hubPoolBlockNumber}`);
  }
  const balances = hubPoolClient.getRunningBalanceBeforeBlockForChain(hubPoolBlockNumber, chainId, hubPoolToken);
  const endBlock = hubPoolClient.getLatestBundleEndBlockForChain([chainId], hubPoolBlockNumber, chainId);
  return {
    blockNumber: endBlock,
    spokePoolBalance: balances.runningBalance,
    incentiveBalance: balances.incentiveBalance,
  };
}

function getFlows(
  chainId: number,
  chainIdIndices: number[],
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  hubPoolClient: HubPoolClient,
  fromBlock?: number,
  toBlock?: number,
  logger?: Logger
): UbaFlow[] {
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
  const fills: UbaFlow[] = spokePoolClient.getFills().filter((fill: FillWithBlock) => {
    const result =
      fill.repaymentChainId === spokePoolClient.chainId &&
      fill.fillAmount.eq(fill.totalFilledAmount) &&
      fill.updatableRelayData.isSlowRelay === false &&
      fill.blockNumber > (fromBlock as number) &&
      fill.blockNumber < (toBlock as number);
    return result;
  });

  const refundRequests: UbaFlow[] = spokePoolClient.getRefundRequests(fromBlock, toBlock).filter((refundRequest) => {
    const result = refundRequestIsValid(chainId, chainIdIndices, spokePoolClients, hubPoolClient, refundRequest);
    if (!result.valid && logger !== undefined) {
      logger.info({
        at: "UBAClient::getFlows",
        message: `Excluding RefundRequest on chain ${chainId}`,
        reason: result.reason,
        refundRequest,
      });
    }

    return result.valid;
  });

  // This is probably more expensive than we'd like... @todo: optimise.
  const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

  return flows;
}

function refundRequestIsValid(
  chainId: number,
  chainIdIndices: number[],
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  hubPoolClient: HubPoolClient,
  refundRequest: RefundRequestWithBlock
): RequestValidReturnType {
  const { relayer, amount, refundToken, depositId, originChainId, destinationChainId, realizedLpFeePct, fillBlock } =
    refundRequest;

  if (!chainIdIndices.includes(originChainId)) {
    return { valid: false, reason: "Invalid originChainId" };
  }
  const originSpoke = spokePoolClients[originChainId];

  if (!chainIdIndices.includes(destinationChainId) || destinationChainId === chainId) {
    return { valid: false, reason: "Invalid destinationChainId" };
  }
  const destSpoke = spokePoolClients[destinationChainId];

  if (fillBlock.lt(destSpoke.deploymentBlock) || fillBlock.gt(destSpoke.latestBlockNumber)) {
    return {
      valid: false,
      reason:
        `FillBlock (${fillBlock} out of SpokePool range` +
        ` [${destSpoke.deploymentBlock}, ${destSpoke.latestBlockNumber}]`,
    };
  }

  // Validate relayer and depositId.
  const fill = destSpoke.getFillsForRelayer(relayer).find((fill) => {
    // prettier-ignore
    return (
        fill.depositId === depositId
        && fill.originChainId === originChainId
        && fill.destinationChainId === destinationChainId
        && fill.amount.eq(amount)
        && fill.realizedLpFeePct.eq(realizedLpFeePct)
        && fill.blockNumber === fillBlock.toNumber()
      );
  });
  if (!isDefined(fill)) {
    return { valid: false, reason: "Unable to find matching fill" };
  }

  const deposit = originSpoke.getDepositForFill(fill);
  if (!isDefined(deposit)) {
    return { valid: false, reason: "Unable to find matching deposit" };
  }

  // Verify that the refundToken maps to a known HubPool token.
  // Note: the refundToken must be valid at the time of the Fill *and* the RefundRequest.
  // @todo: Resolve to the HubPool block number at the time of the RefundRequest ?
  const hubPoolBlockNumber = hubPoolClient.latestBlockNumber ?? hubPoolClient.deploymentBlock - 1;
  try {
    hubPoolClient.getL1TokenCounterpartAtBlock(chainId, refundToken, hubPoolBlockNumber);
  } catch {
    return { valid: false, reason: `Refund token unknown at HubPool block ${hubPoolBlockNumber}` };
  }

  return { valid: true };
}
