import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import {
  DEFAULT_SIMULATED_RELAYER_ADDRESS,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST,
  TOKEN_SYMBOLS_MAP,
} from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import QueryBase from "./baseQuery";

const modeChainId = 34443;
const modeSepoliaChainId = 919;

export class ModeQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", modeChainId),
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

export class ModeSepoliaQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", modeSepoliaChainId),
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
