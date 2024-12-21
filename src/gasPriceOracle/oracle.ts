import assert from "assert";
import { Transport } from "viem";
import { providers } from "ethers";
import { CHAIN_IDs } from "../constants";
import { assert, BigNumber, chainIsOPStack } from "../utils";
import { GasPriceEstimate } from "./types";
import { getPublicClient } from "./util";
import * as arbitrum from "./adapters/arbitrum";
import * as ethereum from "./adapters/ethereum";
import * as linea from "./adapters/linea";
import * as polygon from "./adapters/polygon";
import * as arbitrumViem from "./adapters/arbitrum-viem";
import * as lineaViem from "./adapters/linea-viem";
import * as polygonViem from "./adapters/polygon-viem";

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param chainId The chain ID to query for gas prices.
 * @param provider A valid ethers provider.
 * @param legacyFallback In the case of an unrecognised chain, fall back to type 0 gas estimation.
 * @parm baseFeeMarkup Multiplier applied to base fee for EIP1559 gas prices (or total fee for legacy).
 * @returns Am object of type GasPriceEstimate.
 */
export async function getGasPriceEstimate(
  provider: providers.Provider,
  chainId?: number,
  baseFeeMultiplier = 1.0,
  transport?: Transport,
  legacyFallback = true
): Promise<GasPriceEstimate> {
  assert(
    baseFeeMultiplier >= 1.0 && baseFeeMultiplier <= 5,
    `Require 1.0 < base fee multiplier (${baseFeeMultiplier}) <= 5.0 for a total gas multiplier within [+1.0, +5.0]`
  );

  chainId ?? ({ chainId } = await provider.getNetwork());

  const useViem = process.env[`NEW_GAS_PRICE_ORACLE_${chainId}`] === "true";
  return useViem
    ? getViemGasPriceEstimate(chainId, transport, baseFeeMultiplier)
    : getEthersGasPriceEstimate(provider, chainId, legacyFallback, baseFeeMultiplier);
}

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param chainId The chain ID to query for gas prices.
 * @param provider A valid ethers provider.
 * @param legacyFallback In the case of an unrecognised chain, fall back to type 0 gas estimation.
 * @returns Am object of type GasPriceEstimate.
 */
function getEthersGasPriceEstimate(
  provider: providers.Provider,
  chainId: number,
  legacyFallback = true,
  baseFeeMultiplier = 1.0
): Promise<GasPriceEstimate> {
  const gasPriceFeeds = {
    [CHAIN_IDs.ALEPH_ZERO]: arbitrum.eip1559,
    [CHAIN_IDs.ARBITRUM]: arbitrum.eip1559,
    [CHAIN_IDs.LINEA]: linea.eip1559, // @todo: Support linea_estimateGas in adapter.
    [CHAIN_IDs.MAINNET]: ethereum.eip1559,
    [CHAIN_IDs.POLYGON]: polygon.gasStation,
    [CHAIN_IDs.SCROLL]: ethereum.legacy,
    [CHAIN_IDs.ZK_SYNC]: ethereum.legacy,
  } as const;

  let gasPriceFeed = gasPriceFeeds[chainId];
  assert(gasPriceFeed || legacyFallback, `No suitable gas price oracle for Chain ID ${chainId}`);
  gasPriceFeed ??= chainIsOPStack(chainId) ? ethereum.eip1559 : ethereum.legacy;

  return gasPriceFeed(provider, chainId, baseFeeMultiplier);
}

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param providerOrChainId A valid ethers provider or a chain ID.
 * @param transport An optional transport object for custom gas price retrieval.
 * @returns Am object of type GasPriceEstimate.
 */
export async function getViemGasPriceEstimate(
  providerOrChainId: providers.Provider | number,
  transport?: Transport,
  baseFeeMultiplier = 1.0
): Promise<GasPriceEstimate> {
  const chainId =
    typeof providerOrChainId === "number" ? providerOrChainId : (await providerOrChainId.getNetwork()).chainId;
  const viemProvider = getPublicClient(chainId, transport);

  const gasPriceFeeds = {
    [CHAIN_IDs.ALEPH_ZERO]: arbitrumViem.eip1559,
    [CHAIN_IDs.ARBITRUM]: arbitrumViem.eip1559,
    [CHAIN_IDs.LINEA]: lineaViem.eip1559,
    [CHAIN_IDs.POLYGON]: polygonViem.gasStation,
  } as const;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  if (gasPriceFeeds[chainId]) {
    ({ maxFeePerGas, maxPriorityFeePerGas } = await gasPriceFeeds[chainId](viemProvider, chainId));
  } else {
    let gasPrice: bigint | undefined;
    ({ maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await viemProvider.estimateFeesPerGas());

    maxFeePerGas ??= gasPrice!;
    maxPriorityFeePerGas ??= BigInt(0);
  }

  // Apply markup to base fee which will be  more volatile than priority fee.
  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas.toString()).mul(baseFeeMultiplier),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas.toString()),
  };
}
