import { Transport } from "viem";
import { providers } from "ethers";
import { CHAIN_IDs } from "../constants";
import { BigNumber } from "../utils";
import { GasPriceEstimate } from "./types";
import { getPublicClient } from "./util";
import * as arbitrum from "./adapters/arbitrum";
import * as polygon from "./adapters/polygon";

/**
 * Provide an estimate for the current gas price for a particular chain.
 * @param chainId The chain ID to query for gas prices.
 * @param provider A valid ethers provider.
 * @param legacyFallback In the case of an unrecognised chain, fall back to type 0 gas estimation.
 * @returns Am object of type GasPriceEstimate.
 */
export async function getGasPriceEstimate(provider: providers.Provider, transport?: Transport): Promise<GasPriceEstimate> {
  const { chainId } = await provider.getNetwork();
  const viemProvider = getPublicClient(chainId, transport);

  const gasPriceFeeds = {
    [CHAIN_IDs.ARBITRUM]: arbitrum.eip1559,
    [CHAIN_IDs.POLYGON]: polygon.gasStation,
  } as const;

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  if (gasPriceFeeds[chainId]) {
    // declare function action<chain extends Chain | undefined>(client: Client<Transport, chain>): void
    // action(viemProvider);
    // https://github.com/wevm/viem/issues/2763
    ({ maxFeePerGas, maxPriorityFeePerGas } = await gasPriceFeeds[chainId](viemProvider, chainId));
  } else {
    let gasPrice: bigint | undefined;
    ({ maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await viemProvider.estimateFeesPerGas());
    // console.log(`Got maxFeePerGas: ${maxFeePerGas}, maxPriorityFeePerGas: ${maxPriorityFeePerGas}, gasPrice: ${gasPrice}.`);

    maxFeePerGas ??= gasPrice!;
    maxPriorityFeePerGas ??= BigInt(0);
  }

  return {
    maxFeePerGas: BigNumber.from((maxFeePerGas).toString()),
    maxPriorityFeePerGas: BigNumber.from((maxPriorityFeePerGas).toString())
  };
}
