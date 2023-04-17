import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import QueryBase from "./baseQuery";
import { TOKEN_SYMBOLS_MAP } from "../../constants";

export class EthereumQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0xdd51F496631322954A2aB3FbdbAd676Af4b564B3",
    usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    simulatedRelayerAddress = "0x893d0D70AD97717052E3AA8903D9615804167759",
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
