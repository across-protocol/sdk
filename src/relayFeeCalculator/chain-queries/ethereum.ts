import { providers } from "ethers";
import {
  CHAIN_IDs,
  DEFAULT_SIMULATED_RELAYER_ADDRESS,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
  TOKEN_SYMBOLS_MAP,
} from "../../constants";
import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import QueryBase from "./baseQuery";

export class EthereumQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.MAINNET),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, gasMarkup, logger, coingeckoProApiKey);
  }
}

/**
 * Query class for Ethereum Görli.
 * @deprecated Use EthereumSepoliaQueries instead.
 */
export class EthereumGoerliQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.GOERLI),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, gasMarkup, logger, coingeckoProApiKey);
  }
}

/**
 * Query class for Ethereum Sepolia.
 */
export class EthereumSepoliaQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.SEPOLIA),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, gasMarkup, logger, coingeckoProApiKey);
  }
}
