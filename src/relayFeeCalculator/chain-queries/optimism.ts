import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import QueryBase from "./baseQuery";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "./baseQuery";

export class OptimismQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[10],
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      asL2Provider(provider),
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
