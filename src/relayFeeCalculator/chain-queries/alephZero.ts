import { CHAIN_IDs } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import { QueryBase } from "./baseQuery";

// @dev This class only exists because querying the native token price for this network is not the standard
// CoinGecko query because the native token symbol is not ETH.
export class AlephZeroQueries extends QueryBase {
  override async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );

    const [, alephZeroPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping["AZERO"].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );
    return Number((tokenPrice / alephZeroPrice).toFixed(this.symbolMapping["AZERO"].decimals));
  }
}
