import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP, CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import QueryBase from "./baseQuery";

export class ArbitrumQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.ARBITRUM),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, gasMarkup, logger, coingeckoProApiKey);
  }
}

export class ArbitrumGoerliQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.ARBITRUM_GOERLI),
    simulatedRelayerAddress = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D",
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, gasMarkup, logger, coingeckoProApiKey);
  }
}
