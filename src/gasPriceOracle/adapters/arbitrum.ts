import { providers } from "ethers";
import { bnOne } from "../../utils";
import { GasPriceEstimate } from "../types";
import * as ethereum from "./ethereum";
import { GasPriceEstimateOptions } from "../oracle";

// Arbitrum Nitro implements EIP-1559 pricing, but the priority fee is always refunded to the caller.
// Reference: https://docs.arbitrum.io/how-arbitrum-works/gas-fees
export async function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas } = await ethereum.eip1559(provider, opts);

  // eip1559() sets maxFeePerGas = lastBaseFeePerGas + maxPriorityFeePerGas, so revert that.
  // The caller may apply scaling as they wish afterwards.
  const maxFeePerGas = _maxFeePerGas.sub(maxPriorityFeePerGas).add(bnOne);

  return { maxPriorityFeePerGas: bnOne, maxFeePerGas };
}
