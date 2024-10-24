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
 * @param providerOrChainId A valid ethers provider or a chain ID.
 * @param transport An optional transport object for custom gas price retrieval.
 * @returns Am object of type GasPriceEstimate.
 */
export async function getGasPriceEstimate(
  providerOrChainId: providers.Provider | number,
  transport?: Transport
): Promise<GasPriceEstimate> {
  const chainId =
    typeof providerOrChainId === "number" ? providerOrChainId : (await providerOrChainId.getNetwork()).chainId;
  const viemProvider = getPublicClient(chainId, transport);

  const gasPriceFeeds = {
    [CHAIN_IDs.ARBITRUM]: arbitrum.eip1559,
    [CHAIN_IDs.POLYGON]: polygon.gasStation,
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

  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas.toString()),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas.toString()),
  };
}
