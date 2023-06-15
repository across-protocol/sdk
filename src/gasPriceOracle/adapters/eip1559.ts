import { BigNumber, providers } from "ethers";
import { GasPriceEstimate, gasPriceError } from "../oracle";

export async function eip1559(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const feeData: providers.FeeData = await provider.getFeeData();

  [feeData.lastBaseFeePerGas, feeData.maxPriorityFeePerGas].forEach((field: BigNumber | null) => {
    if (!BigNumber.isBigNumber(field) || field.lt(0)) gasPriceError("getFeeData()", chainId, feeData);
  });

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const maxFeePerGas = maxPriorityFeePerGas.add(feeData.lastBaseFeePerGas as BigNumber);

  return {
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    maxFeePerGas: maxFeePerGas,
  };
}
