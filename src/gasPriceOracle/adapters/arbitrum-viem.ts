import { PublicClient } from "viem";
import { InternalGasPriceEstimate } from "../types";
import { eip1559 as ethereumEip1559 } from "./ethereum-viem";

const MAX_PRIORITY_FEE_PER_GAS = BigInt(1);

// Arbitrum Nitro implements EIP-1559 pricing, but the priority fee is always refunded to the caller.
// Swap it for 1 Wei to avoid inaccurate transaction cost estimates.
// Reference: https://developer.arbitrum.io/faqs/gas-faqs#q-priority
export async function eip1559(
  provider: PublicClient,
  _chainId: number,
  baseFeeMultiplier: number
): Promise<InternalGasPriceEstimate> {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas } = await ethereumEip1559(
    provider,
    _chainId,
    baseFeeMultiplier
  );
  // @dev We need to back out the maxPriorityFee twice since its already added in `ethereumEip1559` to the
  // maxFeePerGas.
  const maxFeePerGas = _maxFeePerGas - maxPriorityFeePerGas * BigInt(2) + MAX_PRIORITY_FEE_PER_GAS;
  return { maxFeePerGas, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS };
}
