// Linea recommend using the custom linea_estimateGas() RPC query.
// This query is currently only available on Linea Sepolia, ETA mainnet 30 July.
// Until then, just parrot the existing Ethereum EIP-1559 pricing strategy.
// See also: https://docs.linea.build/developers/reference/api/linea-estimategas
import { providers } from "ethers";
import { GasPriceEstimate } from "../types";
import * as ethereum from "./ethereum";
import { GasPriceEstimateOptions } from "../oracle";

/**
 * Returns Linea gas price using the legacy eth_gasPrice RPC call.
 * @param provider
 * @param {GasPriceEstimateOptions} opts See notes below on specific parameters.
 * @param baseFeeMultiplier Amount to multiply total fee because this function defaults to legacy gas pricing.
 * @param priorityFeeMultiplier Unused in this function because this defaults to legacy gas computation.
 * @returns
 */
export function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  // We use the legacy method to call `eth_gasPrice` which empirically returns a more accurate
  // gas price estimate than `eth_maxPriorityFeePerGas` or ethersProvider.getFeeData in the EIP1559 "raw" or "bad"
  // cases. Based on testing, `eth_gasPrice` returns the closest price to the Linea-specific `linea_estimateGas`
  // endpoint which the Viem Linea adapter queries.
  return ethereum.legacy(provider, opts);
}
