import assert from "assert";
import { providers } from "ethers";
import { BigNumber, bnZero, fixedPointAdjustment, getNetworkName, parseUnits } from "../../utils";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { GasPriceEstimateOptions } from "../oracle";

/**
 * @dev Constructs total fee by adding eth_getBlock("pending").baseFee to eth_maxPriorityFeePerGas
 * @param provider ethers RPC provider instance.
 * @param {GasPriceEstimateOptions} opts See notes below on specific parameters.
 * @param baseFeeMultiplier Amount to multiply base fee or total fee for legacy gas pricing.
 * @param priorityFeeMultiplier Amount to multiply priority fee or unused for legacy gas pricing.
 * @returns Promise of gas price estimate object.
 */
export function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  return eip1559Raw(provider, opts.chainId, opts.baseFeeMultiplier, opts.priorityFeeMultiplier);
}

/**
 * @note Performs direct RPC calls to retrieve the RPC-suggested priority fee for the next block.
 * @dev Constructs total fee by adding eth_getBlock("pending").baseFee to eth_maxPriorityFeePerGas
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of the provider instance.
 * @returns Promise of gas price estimate object.
 */
export async function eip1559Raw(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: BigNumber,
  priorityFeeMultiplier: BigNumber
): Promise<GasPriceEstimate> {
  const [{ baseFeePerGas }, _maxPriorityFeePerGas] = await Promise.all([
    provider.getBlock("pending"),
    (provider as providers.JsonRpcProvider).send("eth_maxPriorityFeePerGas", []),
  ]);
  const maxPriorityFeePerGas = BigNumber.from(_maxPriorityFeePerGas);
  assert(BigNumber.isBigNumber(baseFeePerGas), `No baseFeePerGas received on ${getNetworkName(chainId)}`);

  let scaledPriorityFee = maxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
  const flooredPriorityFeePerGas = parseUnits(process.env[`MIN_PRIORITY_FEE_PER_GAS_${chainId}`] || "0", 9);
  if (scaledPriorityFee.lt(flooredPriorityFeePerGas)) {
    scaledPriorityFee = BigNumber.from(flooredPriorityFeePerGas);
  }
  const scaledBaseFee = baseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment);
  return {
    maxFeePerGas: scaledPriorityFee.add(scaledBaseFee),
    maxPriorityFeePerGas: scaledPriorityFee,
  };
}

/**
 * @notice Returns result of eth_gasPrice RPC call
 * @dev Its recommended to use the eip1559Raw method over this one where possible as it will be more accurate.
 * @returns GasPriceEstimate
 */
export async function legacy(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const { chainId, baseFeeMultiplier } = opts;
  const gasPrice = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(bnZero)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice.mul(baseFeeMultiplier).div(fixedPointAdjustment),
    maxPriorityFeePerGas: bnZero,
  };
}
