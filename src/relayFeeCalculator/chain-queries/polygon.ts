import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { providers, BigNumber } from "ethers";
import { defaultAverageGas, SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";

export class PolygonQueries implements QueryInterface {
  constructor(
    readonly provider: providers.Provider,
    public readonly averageGas = defaultAverageGas,
    readonly symbolMapping = SymbolMapping
  ) {}

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    return BigNumber.from(await this.provider.getGasPrice())
      .mul(this.averageGas)
      .toString();
  }

  async getTokenPrice(tokenSymbol: string, coingeckoProApiKey?: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = coingeckoProApiKey !== undefined ? Coingecko.getPro(coingeckoProApiKey) : Coingecko.get();
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].address,
      "usd"
    );

    const [, maticPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping["MATIC"].address,
      "usd"
    );
    return Number((tokenPrice / maticPrice).toFixed(this.symbolMapping["MATIC"].decimals));
  }

  getTokenDecimals(tokenSymbol: string): number {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
