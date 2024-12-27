import { CHAIN_IDs } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import { QueryBase } from "./baseQuery";

// @dev This class only exists because querying the native token price for this network is not the standard
// CoinGecko query because the native token symbol is not ETH.
export class PolygonQueries extends QueryBase {
  override async getTokenPrice(tokenSymbol: string): Promise<number> {
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
