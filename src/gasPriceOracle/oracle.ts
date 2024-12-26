import assert from "assert";
import { PublicClient, Transport } from "viem";
import { PopulatedTransaction, providers } from "ethers";
import { CHAIN_IDs } from "../constants";
import { BigNumber, chainIsOPStack } from "../utils";
import { GasPriceEstimate, InternalGasPriceEstimate } from "./types";
import { getPublicClient } from "./util";
import * as arbitrum from "./adapters/arbitrum";
import * as ethereum from "./adapters/ethereum";
import * as linea from "./adapters/linea";
import * as polygon from "./adapters/polygon";
import * as lineaViem from "./adapters/linea-viem";

interface GasPriceEstimateOptions {
  // baseFeeMultiplier Multiplier applied to base fee for EIP1559 gas prices (or total fee for legacy).
  baseFeeMultiplier: number;
  // legacyFallback In the case of an unrecognized chain, fall back to type 0 gas estimation.
  legacyFallback: boolean;
  // chainId The chain ID to query for gas prices. If omitted can be inferred by provider.
  chainId?: number;
  // unsignedTx The unsigned transaction used for simulation by Viem provider to produce the priority gas fee.
  unsignedTx?: PopulatedTransaction;
  // transport Viem Transport object to use for querying gas fees.
  transport?: Transport;
}

interface EthersGasPriceEstimateOptions extends GasPriceEstimateOptions {
  chainId: number;
}

interface ViemGasPriceEstimateOptions extends Partial<GasPriceEstimateOptions> {
  baseFeeMultiplier: number;
}

const GAS_PRICE_ESTIMATE_DEFAULTS: GasPriceEstimateOptions = {
  baseFeeMultiplier: 1,
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
  opts: Partial<GasPriceEstimateOptions>
): Promise<GasPriceEstimate> {
  const {
    baseFeeMultiplier,
    chainId: _chainId,
    unsignedTx,
    transport,
    legacyFallback,
  }: GasPriceEstimateOptions = {
    ...GAS_PRICE_ESTIMATE_DEFAULTS,
    ...opts,
  };
  assert(
    baseFeeMultiplier >= 1.0 && baseFeeMultiplier <= 5,
    `Require 1.0 < base fee multiplier (${baseFeeMultiplier}) <= 5.0 for a total gas multiplier within [+1.0, +5.0]`
  );

  const chainId = _chainId ?? (await provider.getNetwork()).chainId;

  // We only use the unsignedTx in the viem flow.
  const useViem = chainId === CHAIN_IDs.LINEA && process.env[`NEW_GAS_PRICE_ORACLE_${chainId}`] === "true";
  return useViem
    ? _getViemGasPriceEstimate(chainId, { baseFeeMultiplier, unsignedTx, transport })
    : _getEthersGasPriceEstimate(provider, {
        baseFeeMultiplier,
        chainId,
        legacyFallback,
      });
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
  opts: EthersGasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { baseFeeMultiplier, chainId, legacyFallback } = opts;

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
 * @param transport An optional Viem Transport object for custom gas price retrieval.
 * @param unsignedTx Only used in Linea provider to estimate priority gas fee.
 * @returns An object of type GasPriceEstimate.
 */
export async function _getViemGasPriceEstimate(
  providerOrChainId: providers.Provider | number,
  opts: ViemGasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { baseFeeMultiplier, unsignedTx, transport } = opts;

  const chainId =
    typeof providerOrChainId === "number" ? providerOrChainId : (await providerOrChainId.getNetwork()).chainId;
  const viemProvider = getPublicClient(chainId, transport);

  const gasPriceFeeds: Record<
    number,
    (
      provider: PublicClient,
      chainId: number,
      baseFeeMultiplier: number,
      unsignedTx?: PopulatedTransaction
    ) => Promise<InternalGasPriceEstimate>
  > = {
    [CHAIN_IDs.LINEA]: lineaViem.eip1559,
  } as const;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  if (gasPriceFeeds[chainId]) {
    ({ maxFeePerGas, maxPriorityFeePerGas } = await gasPriceFeeds[chainId](
      viemProvider,
      chainId,
      baseFeeMultiplier,
      unsignedTx
    ));
  } else {
    let gasPrice: bigint | undefined;
    ({ maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await viemProvider.estimateFeesPerGas());

    maxFeePerGas ??= gasPrice! * BigInt(baseFeeMultiplier);
    maxPriorityFeePerGas ??= BigInt(0);
  }

  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas.toString()),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas.toString()),
  };
}
