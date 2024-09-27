import { PublicClient } from "viem";
import { InternalGasPriceEstimate } from "../types";

const MAX_PRIORITY_FEE_PER_GAS = BigInt(1);

// Arbitrum Nitro implements EIP-1559 pricing, but the priority fee is always refunded to the caller.
// Swap it for 1 Wei to avoid inaccurate transaction cost estimates.
// Reference: https://developer.arbitrum.io/faqs/gas-faqs#q-priority
export async function eip1559(provider: PublicClient, _chainId: number): Promise<InternalGasPriceEstimate> {
  let { maxFeePerGas, maxPriorityFeePerGas } = await provider.estimateFeesPerGas();
  console.log(`arbitrum: got maxFeePerGas ${maxFeePerGas}, maxPriorityFeePerGas: ${maxPriorityFeePerGas}.`);
  maxFeePerGas = BigInt(maxFeePerGas) - maxPriorityFeePerGas + MAX_PRIORITY_FEE_PER_GAS;
  return { maxFeePerGas, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS };
}
