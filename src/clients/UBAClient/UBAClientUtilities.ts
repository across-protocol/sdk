import { BigNumber } from "ethers";
import { HubPoolClient } from "../HubPoolClient";
import { ERC20__factory, toBN } from "@across-protocol/contracts-v2";
import { calculateUtilizationBoundaries, computePiecewiseLinearFunction } from "../../UBAFeeCalculator/UBAFeeUtility";
import { SpokePoolClient } from "../SpokePoolClient";
import { FlowTupleParameters } from "../../UBAFeeCalculator/UBAFeeConfig";
import { max } from "../../utils";

/**
 * Compute the realized LP fee for a given amount.
 * @param l1TokenAddress The L1 token address to get the LP fee
 * @param depositChainId The chainId of the deposit
 * @param refundChainId The chainId of the refund
 * @param amount The amount that is being deposited
 * @param hubPoolClient A hubpool client instance to query the hubpool
 * @param spokePoolClients A mapping of spoke chainIds to spoke pool clients
 * @param baselineFee The baseline fee to use for this given token
 * @param gammaCutoff The gamma cutoff to use for this given token - used in the piecewise linear function calculation
 * @returns The realized LP fee for the given token on the given chainId at the given block number
 */
export async function computeRealizedLpFeeForRefresh(
  l1TokenAddress: string,
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
  const erc20 = ERC20__factory.connect(l1TokenAddress, hubPoolClient.hubPool.provider);
  const [decimals, ethSpokeBalance, hubBalance, hubEquity, spokeTargets] = await Promise.all([
    erc20.decimals({ blockTag: blockNumber }),
    erc20.balanceOf(spokePoolClients[hubPoolClient.chainId].spokePool.address, { blockTag: blockNumber }),
    erc20.balanceOf(hubPoolClient.hubPool.address, { blockTag: blockNumber }),
    erc20.balanceOf(hubPoolClient.hubPool.address, { blockTag: blockNumber }),
    configStoreClient.getUBATargetSpokeBalances([depositChainId, refundChainId], l1TokenAddress, blockNumber),
  ]);
  const { utilizationPostTx, utilizationPreTx } = calculateUtilizationBoundaries(
    { actionType: "deposit", amount, chainId: depositChainId },
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
