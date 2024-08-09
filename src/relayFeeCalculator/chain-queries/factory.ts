import assert from "assert";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { getDeployedAddress } from "@across-protocol/contracts";
import { asL2Provider } from "@eth-optimism/sdk";
import { providers } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import { chainIsMatic, chainIsOPStack, isDefined } from "../../utils";
import { QueryBase } from "./baseQuery";
import { PolygonQueries } from "./polygon";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";

/**
 * Some chains have a fixed gas price that is applied to the gas estimates. We should override
 * the gas markup for these chains.
 */
const fixedGasPrice = {
  [CHAIN_IDs.BOBA]: 1e9,
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
    gasMarkup = 0,
    coingeckoBaseCurrency = "eth"
  ): QueryBase {
    assert(isDefined(spokePoolAddress));

    // Currently the only chain that has a custom query class is Polygon
    if (chainIsMatic(chainId)) {
      return new PolygonQueries(
        provider,
        symbolMapping,
        spokePoolAddress,
        simulatedRelayerAddress,
        coingeckoProApiKey,
        logger,
        gasMarkup
      );
    }
    // For OPStack chains, we need to wrap the provider in an L2Provider
    provider = chainIsOPStack(chainId) ? asL2Provider(provider) : provider;

    return new QueryBase(
      provider,
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey,
      fixedGasPrice[chainId],
      coingeckoBaseCurrency
    );
  }
}
