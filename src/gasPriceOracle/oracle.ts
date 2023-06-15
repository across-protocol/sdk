import { BigNumber, providers } from "ethers";
import { eip1559, polygonGasStation } from "./adapters";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

interface GasPriceFeed {
  (provider: providers.Provider, chainId: number): Promise<GasPriceEstimate>;
}

export function gasPriceError(method: string, chainId: number, data: providers.FeeData | BigNumber): void {
  throw new Error(`Malformed ${method} response on chain ID ${chainId} (${JSON.stringify(data)})`);
}

async function legacy(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const gasPrice: BigNumber = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(0)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: BigNumber.from(0),
  };
}

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
    42161: legacy,
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
