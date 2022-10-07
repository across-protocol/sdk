import { BigNumber, providers } from "ethers";
import { toBN } from "../utils";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
};

type ValidatedFeeData = {
  gasPrice: BigNumber;
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

interface GasPriceFeed {
  (provider: providers.Provider): Promise<GasPriceEstimate>;
}

function validateFeeData(val: BigNumber | null): BigNumber {
  return BigNumber.isBigNumber(val) ? val : toBN(-1);
}

async function feeDataError(provider: providers.Provider): Promise<void> {
  const network: providers.Network = await provider.getNetwork();
  throw new Error(`Malformed FeeData response on chain ID ${network.chainId}`);
}

async function getProviderFeeData(provider: providers.Provider): Promise<ValidatedFeeData> {
  const response: providers.FeeData = await provider.getFeeData();

  return {
    gasPrice: validateFeeData(response.gasPrice),
    maxFeePerGas: validateFeeData(response.maxFeePerGas),
    maxPriorityFeePerGas: validateFeeData(response.maxPriorityFeePerGas),
  };
}

async function legacy(provider: providers.Provider): Promise<GasPriceEstimate> {
  const feeData: ValidatedFeeData = await getProviderFeeData(provider);

  const maxFeePerGas = feeData.gasPrice;
  if (maxFeePerGas.lt(0)) await feeDataError(provider);

  return { maxFeePerGas };
}

// @todo: Update to ethers 5.7.x to access FeeData.lastBaseFeePerGas
// https://github.com/ethers-io/ethers.js/commit/8314236143a300ae81c1dcc27a7a36640df22061
async function eip1559(provider: providers.Provider): Promise<GasPriceEstimate> {
  const feeData: ValidatedFeeData = await getProviderFeeData(provider);

  const { maxPriorityFeePerGas, maxFeePerGas } = feeData;
  if (maxPriorityFeePerGas.lt(0) || maxFeePerGas.lt(0)) await feeDataError(provider);

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

  const gasPriceEstimate: GasPriceEstimate = await gasPriceFeed(provider);
  return gasPriceEstimate;
}
