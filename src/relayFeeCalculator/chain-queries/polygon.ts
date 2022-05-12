import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { utils } from "ethers";
import { defaultAverageGas, SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import axios from "axios";

const { parseUnits } = utils;

export class PolygonQueries implements QueryInterface {
  constructor(public readonly averageGas = defaultAverageGas, readonly symbolMapping = SymbolMapping) {}

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const result = await axios("https://api.polygonscan.com/api?module=gastracker&action=gasoracle");
    const { FastGasPrice } = result.data.result;
    return parseUnits(FastGasPrice, 9).mul(this.averageGas).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const [, tokenPrice] = await Coingecko.get().getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].address,
      "usd"
    );
    const [, maticPrice] = await Coingecko.get().getCurrentPriceByContract(this.symbolMapping["MATIC"].address, "usd");
    return tokenPrice / maticPrice;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
