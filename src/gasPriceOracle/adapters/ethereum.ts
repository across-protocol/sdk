import { PublicClient } from "viem";
import { InternalGasPriceEstimate } from "../types";

export function eip1559(provider: PublicClient, _chainId: number): Promise<InternalGasPriceEstimate> {
  return provider.estimateFeesPerGas();
}

export async function legacy(
  provider: PublicClient,
  _chainId: number,
  test?: number
): Promise<InternalGasPriceEstimate> {
  const gasPrice = await provider.getGasPrice();

  return {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: BigInt(0),
  };
}
