import { ethers, providers, utils as ethersUtils } from "ethers";
import { GasPriceEstimate } from "../types";
import { eip1559 } from "./ethereum";

// Arbitrum Nitro implements EIP-1559 pricing, but the priority fee is always refunded to the caller. Further,
// ethers typically hardcodes the priority fee to 1.5 Gwei. So, confirm that the priority fee supplied was 1.5
// Gwei, and then drop it to 1 Wei. Reference: https://developer.arbitrum.io/faqs/gas-faqs#q-priority
export async function eip1559_arbitrum(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas } = await eip1559(provider, chainId);

  // If this throws, ethers default behaviour has changed, or Arbitrum RPCs are returning something more sensible.
  if (!maxPriorityFeePerGas.eq(ethersUtils.parseUnits("1.5", 9))) {
    throw new Error(`Expected hardcoded 1.5 Gwei priority fee on Arbitrum, got ${maxPriorityFeePerGas}`);
  }

  // eip1559() sets maxFeePerGas = lastBaseFeePerGas + maxPriorityFeePerGas, so revert that.
  // The caller may apply scaling as they wish afterwards.
  const maxFeePerGas = _maxFeePerGas.sub(maxPriorityFeePerGas).add(1);

  return { maxPriorityFeePerGas: ethers.constants.One, maxFeePerGas };
}
