import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import ethers from "ethers";
import { defaultAverageGas, SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import axios from "axios";

const { parseUnits } = ethers.utils;

export class PolygonQueryInterface implements QueryInterface {
  constructor(public readonly averageGas = defaultAverageGas) {}

  async getGasCosts(tokenSymbol: string): Promise<BigNumberish> {
    const result = await axios("https://api.polygonscan.com/api?module=gastracker&action=gasoracle");
    const { FastGasPrice } = result.data.result.FastGasPrice;
    return parseUnits(FastGasPrice, 9).mul(this.averageGas).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    const [, tokenPrice] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping[tokenSymbol].address, "usd");
    const [, maticPrice] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping["MATIC"].address, "usd");
    return tokenPrice / maticPrice;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    return SymbolMapping[tokenSymbol].decimals;
  }
}
