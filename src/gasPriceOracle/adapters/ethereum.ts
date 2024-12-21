import assert from "assert";
import { providers } from "ethers";
import { BigNumber, bnZero, getNetworkName } from "../../utils";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";

/**
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of provider instance.
 * @returns Promise of gas price estimate object.
 */
export function eip1559(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: number
): Promise<GasPriceEstimate> {
  const useRaw = process.env[`GAS_PRICE_EIP1559_RAW_${chainId}`] === "true";
  return useRaw ? eip1559Raw(provider, chainId, baseFeeMultiplier) : eip1559Bad(provider, chainId, baseFeeMultiplier);
}

/**
 * @note Performs direct RPC calls to retrieve the RPC-suggested priority fee for the next block.
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of the provider instance.
 * @returns Promise of gas price estimate object.
 */
export async function eip1559Raw(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: number
): Promise<GasPriceEstimate> {
  const [{ baseFeePerGas }, _maxPriorityFeePerGas] = await Promise.all([
    provider.getBlock("pending"),
    (provider as providers.JsonRpcProvider).send("eth_maxPriorityFeePerGas", []),
  ]);
  const maxPriorityFeePerGas = BigNumber.from(_maxPriorityFeePerGas);
  assert(BigNumber.isBigNumber(baseFeePerGas), `No baseFeePerGas received on ${getNetworkName(chainId)}`);

  return {
    maxFeePerGas: maxPriorityFeePerGas.mul(baseFeeMultiplier).add(baseFeePerGas),
    maxPriorityFeePerGas,
  };
}

/**
 * @note Resolves priority gas pricing poorly, because the priority fee is hardcoded to 1.5 Gwei in ethers v5.
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of the provider instance.
 * @returns Promise of gas price estimate object.
 */
export async function eip1559Bad(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: number
): Promise<GasPriceEstimate> {
  const feeData = await provider.getFeeData();

  [feeData.lastBaseFeePerGas, feeData.maxPriorityFeePerGas].forEach((field: BigNumber | null) => {
    if (!BigNumber.isBigNumber(field) || field.lt(bnZero)) gasPriceError("getFeeData()", chainId, feeData);
  });

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const scaledLastBaseFeePerGas = (feeData.lastBaseFeePerGas as BigNumber).mul(baseFeeMultiplier);
  const maxFeePerGas = maxPriorityFeePerGas.add(scaledLastBaseFeePerGas);

  return { maxPriorityFeePerGas, maxFeePerGas };
}

export async function legacy(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: number
): Promise<GasPriceEstimate> {
  const gasPrice = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(bnZero)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice.mul(baseFeeMultiplier),
    maxPriorityFeePerGas: bnZero,
  };
}
