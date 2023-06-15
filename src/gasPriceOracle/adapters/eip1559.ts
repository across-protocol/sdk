import { BigNumber, providers } from "ethers";
import { GasPriceEstimate, gasPriceError } from "../oracle";

// @todo: Update to ethers 5.7.x to access FeeData.lastBaseFeePerGas. Use feeData.gasPrice until then.
// https://github.com/ethers-io/ethers.js/commit/8314236143a300ae81c1dcc27a7a36640df22061
export async function eip1559(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const feeData: providers.FeeData = await provider.getFeeData();

  [feeData.gasPrice, feeData.maxPriorityFeePerGas].forEach((field: BigNumber | null) => {
    if (!BigNumber.isBigNumber(field) || field.lt(0)) gasPriceError("getFeeData()", chainId, feeData);
  });

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const maxFeePerGas = maxPriorityFeePerGas.add(feeData.gasPrice as BigNumber); // note gasPrice is used.

  return {
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    maxFeePerGas: maxFeePerGas,
  };
}
