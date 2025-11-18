import assert from "assert";
import { CHAIN_IDs, PUBLIC_NETWORKS, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { getDeployedAddress } from "@across-protocol/contracts";
import { asL2Provider } from "@eth-optimism/sdk";
import { providers } from "ethers";
import { chainIsEvm, chainIsOPStack, isDefined, chainIsSvm, SvmAddress } from "../../utils";
import { QueryBase } from "./baseQuery";
import { SVMProvider as svmProvider } from "../../arch/svm";
import { DEFAULT_LOGGER, getDefaultRelayer, Logger } from "../relayFeeCalculator";
import { CustomGasTokenQueries } from "./customGasToken";
import { SvmQuery } from "./svmQuery";

/**
 * Some chains have a fixed gas price that is applied to the gas estimates. We should override
 * the gas markup for these chains.
 */
const fixedGasPrice = {
  [CHAIN_IDs.BOBA]: 1e9,
};

// Lens is an exceptional chain due to Lens GHO not mapping directly to Ethereum GHO.
const gasTokenOverrides = {
  [CHAIN_IDs.LENS]: "GHO",
  [CHAIN_IDs.LENS_SEPOLIA]: "GHO",
};

export class QueryBase__factory {
  static create(
    chainId: number,
    provider: providers.Provider | svmProvider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", chainId),
    relayerAddress = getDefaultRelayer(chainId),
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    coingeckoBaseCurrency = "eth"
  ): QueryBase | SvmQuery {
    assert(isDefined(spokePoolAddress));

    const { nativeToken } = PUBLIC_NETWORKS[chainId];
    if (chainIsEvm(chainId) && nativeToken !== "ETH") {
      assert(relayerAddress.isEVM());

      const customGasTokenSymbol = gasTokenOverrides[chainId] ?? nativeToken;
      return new CustomGasTokenQueries({
        queryBaseArgs: [
          provider as providers.Provider,
          symbolMapping,
          spokePoolAddress,
          relayerAddress,
          logger,
          coingeckoProApiKey,
          fixedGasPrice[chainId],
          "usd",
        ],
        customGasTokenSymbol,
      });
    }

    if (chainIsSvm(chainId)) {
      assert(relayerAddress.isSVM());
      return new SvmQuery(
        provider as svmProvider,
        symbolMapping,
        SvmAddress.from(spokePoolAddress),
        relayerAddress,
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

    assert(relayerAddress.isEVM());
    return new QueryBase(
      provider,
      symbolMapping,
      spokePoolAddress,
      relayerAddress,
      logger,
      coingeckoProApiKey,
      fixedGasPrice[chainId],
      coingeckoBaseCurrency
    );
  }
}
