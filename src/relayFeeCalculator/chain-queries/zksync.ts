import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../../constants";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "./baseQuery";
import QueryBase from "./baseQuery";

export class ZkSyncQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF",
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[324],
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      usdcAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}

export class zkSyncGoerliQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0x863859ef502F0Ee9676626ED5B418037252eFeb2",
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[280],
    simulatedRelayerAddress = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D",
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      usdcAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}
