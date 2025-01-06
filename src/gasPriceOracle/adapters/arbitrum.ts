import { providers } from "ethers";
import { bnOne } from "../../utils";
import { GasPriceEstimate } from "../types";
import * as ethereum from "./ethereum";
import { GasPriceEstimateOptions } from "../oracle";

/**
 * @notice Return Arbitrum orbit gas fees
 * @dev Arbitrum Nitro implements EIP-1559 pricing, but the priority fee is always refunded to the caller.
 * Reference: https://docs.arbitrum.io/how-arbitrum-works/gas-fees so we hardcode the priority fee
 * to 1 wei.
 * @param provider Ethers Provider
 * @param {GasPriceEstimateOptions} opts See notes below on specific parameters.
 * @param baseFeeMultiplier Amount to multiply base fee.
 * @param priorityFeeMultiplier Unused in this function because arbitrum priority fee is hardcoded to 1 wei by this
 * function.
 * @returns GasPriceEstimate
 */
export async function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas } = await ethereum.eip1559(provider, opts);

  // eip1559() sets maxFeePerGas = lastBaseFeePerGas + maxPriorityFeePerGas, so back out priority fee.
  // The remaining maxFeePerGas should be scaled already.
  const maxFeePerGas = _maxFeePerGas.sub(maxPriorityFeePerGas).add(bnOne);

  return { maxPriorityFeePerGas: bnOne, maxFeePerGas };
}
