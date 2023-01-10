import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../../constants";
import QueryBase from "./baseQuery";

export class ArbitrumQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
    usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
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
