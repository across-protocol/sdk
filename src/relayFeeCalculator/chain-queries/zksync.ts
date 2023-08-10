import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../../constants";
import QueryBase from "./baseQuery";

export class ZkSyncQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF",
    usdcAddress = "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4",
    simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759",
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
    usdcAddress = "0x0faF6df7054946141266420b43783387A78d82A9",
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
