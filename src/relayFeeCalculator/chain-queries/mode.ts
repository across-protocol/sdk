import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST, TOKEN_SYMBOLS_MAP } from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import QueryBase from "./baseQuery";

export class ModeSepoliaQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0xf582712a2d605435b901066aaae05f99E0ef31b9",
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
