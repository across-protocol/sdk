import { TronWeb } from "tronweb";
import { toBN } from "../../utils";
import { TvmGasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";

/**
 * @notice Returns energy and bandwidth prices for the TRON network.
 * @param provider A TronWeb instance.
 * @param _opts Gas price estimate options (unused, kept for interface consistency).
 * @returns TvmGasPriceEstimate with energyPrice and bandwidthPrice in SUN per unit.
 */
export async function gasPrices(provider: TronWeb, _opts: GasPriceEstimateOptions): Promise<TvmGasPriceEstimate> {
  const [energyPrice, bandwidthPrice] = await Promise.all([getEnergyPrice(provider), getBandwidthPrice(provider)]);

  return {
    energyPrice: toBN(energyPrice),
    bandwidthPrice: toBN(bandwidthPrice),
  };
}

/**
 * Query the current energy price in SUN per unit of energy.
 * Parses the last entry from the comma-separated "timestamp:price" string.
 */
async function getEnergyPrice(tronWeb: TronWeb): Promise<number> {
  const pricesStr = await tronWeb.trx.getEnergyPrices();
  const entries = pricesStr.split(",");
  const lastEntry = entries[entries.length - 1];
  const price = Number(lastEntry.split(":")[1]);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`getEnergyPrice: unexpected energy price: ${lastEntry}`);
  }

  return price;
}

/**
 * Query the current bandwidth price (getTransactionFee) from chain parameters.
 */
async function getBandwidthPrice(tronWeb: TronWeb): Promise<number> {
  const params = await tronWeb.trx.getChainParameters();
  const entry = params.find((p: { key: string; value: number }) => p.key === "getTransactionFee");

  if (!entry) {
    throw new Error("getBandwidthPrice: getTransactionFee not found in chain parameters");
  }

  return entry.value;
}
