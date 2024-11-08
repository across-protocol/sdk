import { providers } from "ethers";
import { CHAIN_IDs } from "../constants";
import { chainIsOPStack } from "../utils";
import { GasPriceEstimate, GasPriceFeed } from "./types";
import * as arbitrum from "./adapters/arbitrum";
import * as ethereum from "./adapters/ethereum";
import * as linea from "./adapters/linea";
import * as polygon from "./adapters/polygon";

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
  if (chainId === undefined) {
    ({ chainId } = await provider.getNetwork());
  }

  const gasPriceFeeds: { [chainId: number]: GasPriceFeed } = {
    [CHAIN_IDs.ALEPH_ZERO]: arbitrum.eip1559,
    [CHAIN_IDs.ARBITRUM]: arbitrum.eip1559,
    [CHAIN_IDs.BASE]: ethereum.eip1559,
    [CHAIN_IDs.BOBA]: ethereum.legacy,
    [CHAIN_IDs.LINEA]: linea.eip1559, // @todo: Support linea_estimateGas in adapter.
    [CHAIN_IDs.MAINNET]: ethereum.eip1559,
    [CHAIN_IDs.MODE]: ethereum.eip1559,
    [CHAIN_IDs.OPTIMISM]: ethereum.eip1559,
    [CHAIN_IDs.POLYGON]: polygon.gasStation,
    [CHAIN_IDs.ZK_SYNC]: ethereum.legacy,
    [CHAIN_IDs.SCROLL]: ethereum.legacy,
  };

  let gasPriceFeed = gasPriceFeeds[chainId];
  if (gasPriceFeed === undefined) {
    if (!legacyFallback) {
      throw new Error(`No suitable gas price oracle for Chain ID ${chainId}`);
    }
    gasPriceFeed = chainIsOPStack(chainId) ? ethereum.eip1559 : ethereum.legacy;
  }

  return gasPriceFeed(provider, chainId);
}
