import assert from "assert";
import { providers } from "ethers";
import { BigNumber, bnZero, fixedPointAdjustment, getNetworkName } from "../../utils";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { GasPriceEstimateOptions } from "../oracle";

// TODO: We intend to remove `eip1559Bad()` as an option and make eip1559Raw the only option eventually. The reason
// they both exist currently is because eip1559Raw is new and untested on production so we will slowly roll it out
// by using the convenient environment variable safety guard.

/**
 * @dev If GAS_PRICE_EIP1559_RAW_${chainId}=true, then constructs total fee by adding
 * eth_getBlock("pending").baseFee to eth_maxPriorityFeePerGas, otherwise calls the ethers provider's
 * getFeeData() method which adds eth_getBlock("latest").baseFee to a hardcoded priority fee of 1.5 gwei.
 * @param provider ethers RPC provider instance.
 * @param {GasPriceEstimateOptions} opts See notes below on specific parameters.
 * @param baseFeeMultiplier Amount to multiply base fee or total fee for legacy gas pricing.
 * @param priorityFeeMultiplier Amount to multiply priority fee or unused for legacy gas pricing.
 * @returns Promise of gas price estimate object.
 */
export function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const useRaw = process.env[`GAS_PRICE_EIP1559_RAW_${opts.chainId}`] === "true";
  return useRaw
    ? eip1559Raw(provider, opts.chainId, opts.baseFeeMultiplier, opts.priorityFeeMultiplier)
    : eip1559Bad(provider, opts.chainId, opts.baseFeeMultiplier, opts.priorityFeeMultiplier);
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

  const scaledPriorityFee = maxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
  const scaledBaseFee = baseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment);
  return {
    maxFeePerGas: scaledPriorityFee.add(scaledBaseFee),
    maxPriorityFeePerGas: scaledPriorityFee,
  };
}

/**
 * @notice Returns fee data using provider's getFeeData() method.
 * @note Resolves priority gas pricing poorly, because the priority fee is hardcoded to 1.5 Gwei in ethers v5's
 * getFeeData() method
 * @dev TODO: Remove this function soon. See note above about slowly rolling out eip1559Raw.
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of the provider instance.
 * @returns Promise of gas price estimate object.
 */
export async function eip1559Bad(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: BigNumber,
  priorityFeeMultiplier: BigNumber
): Promise<GasPriceEstimate> {
  const feeData = await provider.getFeeData();

  [feeData.lastBaseFeePerGas, feeData.maxPriorityFeePerGas].forEach((field: BigNumber | null) => {
    if (!BigNumber.isBigNumber(field) || field.lt(bnZero)) gasPriceError("getFeeData()", chainId, feeData);
  });

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const scaledPriorityFee = maxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
  const scaledLastBaseFeePerGas = (feeData.lastBaseFeePerGas as BigNumber)
    .mul(baseFeeMultiplier)
    .div(fixedPointAdjustment);
  const maxFeePerGas = scaledPriorityFee.add(scaledLastBaseFeePerGas);

  return { maxPriorityFeePerGas: scaledPriorityFee, maxFeePerGas };
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
