import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import {
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  DEFAULT_SIMULATED_RELAYER_ADDRESS,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
} from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import QueryBase from "./baseQuery";

export class OptimismQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.OPTIMISM),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      asL2Provider(provider),
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}

/**
 * Queries for the Optimism Goerli chain
 * @deprecated Use OptimismSepoliaQueries instead
 */
export class OptimismGoerliQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.OPTIMISM_GOERLI),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      asL2Provider(provider),
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}

export class OptimismSepoliaQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.OPTIMISM_SEPOLIA),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      asL2Provider(provider),
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}
