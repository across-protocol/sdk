import assert from "assert";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { getDeployedAddress } from "@across-protocol/contracts";
import { asL2Provider } from "@eth-optimism/sdk";
import { providers } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import { chainIsOPStack, isDefined } from "../../utils";
import { QueryBase } from "./baseQuery";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { CustomGasTokenQueries } from "./customGasToken";

/**
 * Some chains have a fixed gas price that is applied to the gas estimates. We should override
 * the gas markup for these chains.
 */
const fixedGasPrice = {
  [CHAIN_IDs.BOBA]: 1e9,
};

/**
 * Some chains have a custom gas token that we need to use for normalizing token prices.
 */
const customGasTokens = {
  [CHAIN_IDs.POLYGON]: "MATIC",
  [CHAIN_IDs.POLYGON_AMOY]: "MATIC",
  [CHAIN_IDs.ALEPH_ZERO]: "AZERO",
  // FIXME: Replace with GRASS price once listed on Coingecko.
  // For testing purposes, we use ETH price instead.
  [CHAIN_IDs.LENS_SEPOLIA]: "ETH",
};

export class QueryBase__factory {
  static create(
    chainId: number,
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", chainId),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    coingeckoBaseCurrency = "eth"
  ): QueryBase {
    assert(isDefined(spokePoolAddress));

    const customGasTokenSymbol = customGasTokens[chainId];
    if (customGasTokenSymbol) {
      return new CustomGasTokenQueries({
        queryBaseArgs: [
          provider,
          symbolMapping,
          spokePoolAddress,
          simulatedRelayerAddress,
          logger,
          coingeckoProApiKey,
          fixedGasPrice[chainId],
          "usd",
        ],
        customGasTokenSymbol,
      });
    }

    // For OPStack chains, we need to wrap the provider in an L2Provider
    provider = chainIsOPStack(chainId) ? asL2Provider(provider) : provider;

    return new QueryBase(
      provider,
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      logger,
      coingeckoProApiKey,
      fixedGasPrice[chainId],
      coingeckoBaseCurrency
    );
  }
}
