import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "./baseQuery";
import QueryBase from "./baseQuery";

export class PolygonQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[137],
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
      coingeckoProApiKey,
      undefined,
      "usd"
    );
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );

    const [, maticPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping["MATIC"].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );
    return Number((tokenPrice / maticPrice).toFixed(this.symbolMapping["MATIC"].decimals));
  }
}
