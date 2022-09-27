import { BigNumber, providers } from "ethers";
import { toBN } from "../utils";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
};

type ValidatedFeeData = {
  [idx: string]: BigNumber;
  gasPrice: BigNumber;
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

interface GasPriceFeed {
  (provider: providers.Provider): Promise<GasPriceEstimate>;
}

async function getProviderFeeData(provider: providers.Provider): Promise<ValidatedFeeData> {
  // Start with safe defaults.
  const feeData: ValidatedFeeData = {
    gasPrice: toBN(Number.MAX_SAFE_INTEGER),
    maxFeePerGas: toBN(Number.MAX_SAFE_INTEGER),
    maxPriorityFeePerGas: toBN(Number.MAX_SAFE_INTEGER),
    // lastBaseFeePerGas: toBN(Number.MAX_SAFE_INTEGER), @todo: ethers 5.7.x
  };

  try {
    const response: providers.FeeData = await provider.getFeeData();
    const expectedKeys: string[] = Object.keys(feeData);
    Object.entries(response).forEach(([key, value]) => {
      if (expectedKeys.includes(key) && BigNumber.isBigNumber(value) && value.gt(0)) {
        feeData[key] = toBN(value);
      }
    });
  } catch {
    // No logging, so nothing to do here...
  }

  return feeData;
}

async function legacy(provider: providers.Provider): Promise<GasPriceEstimate> {
  const feeData: ValidatedFeeData = await getProviderFeeData(provider);

  return {
    maxFeePerGas: feeData.gasPrice,
  } as GasPriceEstimate;
}

// @todo: Update to ethers 5.7.x to access FeeData.lastBaseFeePerGas
// https://github.com/ethers-io/ethers.js/commit/8314236143a300ae81c1dcc27a7a36640df22061
async function eip1559(provider: providers.Provider): Promise<GasPriceEstimate> {
  const feeData: ValidatedFeeData = await getProviderFeeData(provider);
  const maxPriorityFeePerGas: BigNumber = feeData.maxPriorityFeePerGas;

  return {
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    maxFeePerGas: maxPriorityFeePerGas.add(feeData.maxFeePerGas),
  } as GasPriceEstimate;
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

  const gasPriceEstimate: GasPriceEstimate = await gasPriceFeed(provider);
  return gasPriceEstimate;
}
