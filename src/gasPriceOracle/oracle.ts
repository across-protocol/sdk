import { providers } from "ethers";
import { eip1559, eip1559_arbitrum, legacy, polygonGasStation } from "./adapters";
import { GasPriceEstimate, GasPriceFeed } from "./types";

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param chainId The chain ID to query for gas prices.
 * @param provider A valid ethers provider.
 * @param legacyFallback In the case of an unrecognised chain, fall back to type 0 gas estimation.
 * @returns Am object of type GasPriceEstimate.
 */
export async function getGasPriceEstimate(
  provider: providers.Provider,
  chainId?: number,
  legacyFallback = true
): Promise<GasPriceEstimate> {
  if (!chainId) {
    const network: providers.Network = await provider.getNetwork();
    chainId = network.chainId;
  }

  const gasPriceFeeds: { [chainId: number]: GasPriceFeed } = {
    1: eip1559,
    10: eip1559,
    137: polygonGasStation,
    288: legacy,
    324: legacy,
    8453: eip1559,
    42161: eip1559_arbitrum,
  };

  let gasPriceFeed: GasPriceFeed = gasPriceFeeds[chainId];
  if (gasPriceFeed === undefined) {
    if (!legacyFallback) {
      throw new Error(`No suitable gas price oracle for Chain ID ${chainId}`);
    }
    gasPriceFeed = legacy;
  }

  const gasPriceEstimate: GasPriceEstimate = await gasPriceFeed(provider, chainId);
  return gasPriceEstimate;
}
