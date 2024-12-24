import { PublicClient } from "viem";
import { InternalGasPriceEstimate } from "../types";
import { BigNumber } from "../../utils";

export async function eip1559(
  provider: PublicClient,
  _chainId: number,
  baseFeeMultiplier: number
): Promise<InternalGasPriceEstimate> {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas } = await provider.estimateFeesPerGas();
  const maxFeePerGasScaled = BigNumber.from(_maxFeePerGas.toString()).mul(baseFeeMultiplier);
  const maxFeePerGas = BigInt(maxFeePerGasScaled.toString()) + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

export async function legacy(
  provider: PublicClient,
  _chainId: number,
  _test?: number
): Promise<InternalGasPriceEstimate> {
  const gasPrice = await provider.getGasPrice();

  return {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: BigInt(0),
  };
}
