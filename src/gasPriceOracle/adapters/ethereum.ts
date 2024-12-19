import { providers } from "ethers";
import { BigNumber, bnZero } from "../../utils";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";

export async function eip1559(
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

export async function legacy(provider: providers.Provider, chainId: number, markup: number): Promise<GasPriceEstimate> {
  const gasPrice = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(bnZero)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice.mul(markup),
    maxPriorityFeePerGas: bnZero,
  };
}
