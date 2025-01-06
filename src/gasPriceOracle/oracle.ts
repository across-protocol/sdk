import assert from "assert";
import { Transport } from "viem";
import { PopulatedTransaction, providers } from "ethers";
import { CHAIN_IDs } from "../constants";
import { BigNumber, chainIsOPStack, fixedPointAdjustment, toBNWei } from "../utils";
import { GasPriceEstimate } from "./types";
import { getPublicClient } from "./util";
import * as arbitrum from "./adapters/arbitrum";
import * as ethereum from "./adapters/ethereum";
import * as linea from "./adapters/linea";
import * as polygon from "./adapters/polygon";
import * as lineaViem from "./adapters/linea-viem";

export interface GasPriceEstimateOptions {
  // baseFeeMultiplier Multiplier applied to base fee for EIP1559 gas prices (or total fee for legacy).
  baseFeeMultiplier: BigNumber;
  // priorityFeeMultiplier Multiplier applied to priority fee for EIP1559 gas prices (ignored for legacy).
  priorityFeeMultiplier: BigNumber;
  // legacyFallback In the case of an unrecognized chain, fall back to type 0 gas estimation.
  legacyFallback: boolean;
  // chainId The chain ID to query for gas prices. If omitted can be inferred by provider.
  chainId: number;
  // unsignedTx The unsigned transaction used for simulation by Linea's Viem provider to produce the priority gas fee.
  unsignedTx?: PopulatedTransaction;
  // transport Viem Transport object to use for querying gas fees used for testing.
  transport?: Transport;
}

const GAS_PRICE_ESTIMATE_DEFAULTS = {
  legacyFallback: true,
};

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param provider A valid ethers provider.
 * @param {opts} GasPriceEstimateOptions optional parameters.
 * @returns An  object of type GasPriceEstimate.
 */
export async function getGasPriceEstimate(
  provider: providers.Provider,
  opts: Partial<GasPriceEstimateOptions> = {}
): Promise<GasPriceEstimate> {
  const baseFeeMultiplier = opts.baseFeeMultiplier ?? toBNWei("1");
  assert(
    baseFeeMultiplier.gte(toBNWei("1.0")) && baseFeeMultiplier.lte(toBNWei("5")),
    `Require 1.0 < base fee multiplier (${baseFeeMultiplier}) <= 5.0 for a total gas multiplier within [+1.0, +5.0]`
  );
  const priorityFeeMultiplier = opts.priorityFeeMultiplier ?? toBNWei("1");
  assert(
    priorityFeeMultiplier.gte(toBNWei("1.0")) && priorityFeeMultiplier.lte(toBNWei("5")),
    `Require 1.0 < priority fee multiplier (${priorityFeeMultiplier}) <= 5.0 for a total gas multiplier within [+1.0, +5.0]`
  );

  const chainId = opts.chainId ?? (await provider.getNetwork()).chainId;
  const optsWithDefaults: GasPriceEstimateOptions = {
    ...GAS_PRICE_ESTIMATE_DEFAULTS,
    baseFeeMultiplier,
    priorityFeeMultiplier,
    ...opts,
    chainId,
  };

  // We only use the unsignedTx in the viem flow.
  const useViem = process.env[`NEW_GAS_PRICE_ORACLE_${chainId}`] === "true";
  return useViem
    ? _getViemGasPriceEstimate(chainId, optsWithDefaults)
    : _getEthersGasPriceEstimate(provider, optsWithDefaults);
}

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param chainId The chain ID to query for gas prices.
 * @param provider A valid ethers provider.
 * @param legacyFallback In the case of an unrecognised chain, fall back to type 0 gas estimation.
 * @returns An object of type GasPriceEstimate.
 */
function _getEthersGasPriceEstimate(
  provider: providers.Provider,
  opts: GasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { chainId, legacyFallback } = opts;

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

  return gasPriceFeed(provider, opts);
}

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param providerOrChainId A valid ethers provider or a chain ID.
 * @param transport An optional Viem Transport object for custom gas price retrieval.
 * @param unsignedTx Only used in Linea provider to estimate priority gas fee.
 * @returns An object of type GasPriceEstimate.
 */
export async function _getViemGasPriceEstimate(
  providerOrChainId: providers.Provider | number,
  opts: GasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { baseFeeMultiplier, transport } = opts;

  const chainId =
    typeof providerOrChainId === "number" ? providerOrChainId : (await providerOrChainId.getNetwork()).chainId;
  const viemProvider = getPublicClient(chainId, transport);

  const gasPriceFeeds = {
    [CHAIN_IDs.LINEA]: lineaViem.eip1559,
  };

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  if (gasPriceFeeds[chainId]) {
    ({ maxFeePerGas, maxPriorityFeePerGas } = await gasPriceFeeds[chainId](viemProvider, opts));
  } else {
    let gasPrice: bigint | undefined;
    ({ maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await viemProvider.estimateFeesPerGas());

    maxFeePerGas ??= (gasPrice! * BigInt(baseFeeMultiplier.toString())) / BigInt(fixedPointAdjustment.toString());
    maxPriorityFeePerGas ??= BigInt(0);
  }

  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas.toString()),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas.toString()),
  };
}
