import { BigNumber, providers } from "ethers";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
};

interface GasPriceFeed {
  (provider: providers.Provider, chainId: number): Promise<GasPriceEstimate>;
}

function feeDataError(chainId: number, data: providers.FeeData | BigNumber): void {
  throw new Error(`Malformed FeeData response on chain ID ${chainId} (${JSON.stringify(data)}`);
}

async function legacy(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const gasPrice: BigNumber = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice)) feeDataError(chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice,
  };
}

// @todo: Update to ethers 5.7.x to access FeeData.lastBaseFeePerGas
// https://github.com/ethers-io/ethers.js/commit/8314236143a300ae81c1dcc27a7a36640df22061
async function eip1559(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const feeData: providers.FeeData = await provider.getFeeData();

  if (!(BigNumber.isBigNumber(feeData.maxPriorityFeePerGas) && BigNumber.isBigNumber(feeData.maxFeePerGas)))
    feeDataError(chainId, feeData);

  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas as BigNumber;
  const maxFeePerGas = feeData.maxFeePerGas as BigNumber;

  return {
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    maxFeePerGas: maxPriorityFeePerGas.add(maxFeePerGas),
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
    137: eip1559, // @todo: Query Polygon Gas Station directly
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
