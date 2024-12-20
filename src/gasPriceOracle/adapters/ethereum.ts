import { providers } from "ethers";
import { BigNumber, bnZero } from "../../utils";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";

export async function eip1559(provider: providers.Provider, _chainId: number): Promise<GasPriceEstimate> {
  const [{ baseFeePerGas }, _maxPriorityFeePerGas] = await Promise.all([
    provider.getBlock("pending"),
    (provider as providers.JsonRpcProvider).send("eth_maxPriorityFeePerGas", []),
  ]);
  const maxPriorityFeePerGas = BigNumber.from(_maxPriorityFeePerGas);

  return {
    maxFeePerGas: maxPriorityFeePerGas.add(baseFeePerGas ?? 0),
    maxPriorityFeePerGas,
  };
}

export async function legacy(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const gasPrice = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(bnZero)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: bnZero,
  };
}
