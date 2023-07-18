import { BigNumber, providers, ethers } from "ethers";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";

export async function eip1559(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const feeData = await provider.getFeeData();

  [feeData.lastBaseFeePerGas, feeData.maxPriorityFeePerGas].forEach((field: BigNumber | null) => {
    if (!BigNumber.isBigNumber(field) || field.lt(0)) gasPriceError("getFeeData()", chainId, feeData);
  });

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const maxFeePerGas = maxPriorityFeePerGas.add(feeData.lastBaseFeePerGas as BigNumber);

  return { maxPriorityFeePerGas, maxFeePerGas };
}

export async function legacy(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const gasPrice: BigNumber = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(0)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: ethers.constants.Zero,
  };
}
