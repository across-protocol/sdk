// Linea recommend using the custom linea_estimateGas() RPC query.
// This query is currently only available on Linea Sepolia, ETA mainnet 30 July.
// Until then, just parrot the existing Ethereum EIP-1559 pricing strategy.
// See also: https://docs.linea.build/developers/reference/api/linea-estimategas
import { providers } from "ethers";
import { GasPriceEstimate } from "../types";
import * as ethereum from "./ethereum";
import { GasPriceEstimateOptions } from "../oracle";

export function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  return ethereum.legacy(provider, opts);
}
