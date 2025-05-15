import assert from "assert";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { getDeployedAddress } from "@across-protocol/contracts";
import { asL2Provider } from "@eth-optimism/sdk";
import { providers } from "ethers";
import { CUSTOM_GAS_TOKENS } from "../../constants";
import { chainIsOPStack, isDefined, chainIsSvm, SvmAddress } from "../../utils";
import { QueryBase } from "./baseQuery";
import { SVMProvider as svmProvider } from "../../arch/svm";
import { DEFAULT_LOGGER, getDefaultSimulatedRelayerAddress, Logger } from "../relayFeeCalculator";
import { CustomGasTokenQueries } from "./customGasToken";
import { SvmQuery } from "./svmQuery";

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
    provider: providers.Provider | svmProvider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", chainId),
    simulatedRelayerAddress = getDefaultSimulatedRelayerAddress(chainId),
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    coingeckoBaseCurrency = "eth"
  ): QueryBase | SvmQuery {
    assert(isDefined(spokePoolAddress));

    const customGasTokenSymbol = CUSTOM_GAS_TOKENS[chainId];
    if (customGasTokenSymbol) {
      return new CustomGasTokenQueries({
        queryBaseArgs: [
          provider as providers.Provider,
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
    if (chainIsSvm(chainId)) {
      return new SvmQuery(
        provider as svmProvider,
        symbolMapping,
        SvmAddress.from(spokePoolAddress),
        SvmAddress.from(simulatedRelayerAddress),
        logger,
        coingeckoProApiKey,
        fixedGasPrice[chainId],
        coingeckoBaseCurrency
      );
    }

    // For OPStack chains, we need to wrap the provider in an L2Provider
    provider = chainIsOPStack(chainId)
      ? asL2Provider(provider as providers.Provider)
      : (provider as providers.Provider);

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
