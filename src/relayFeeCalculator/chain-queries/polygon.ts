import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import ethers from "ethers";
import { evmRelayAverageGas, SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";

const { parseUnits } = ethers.utils;

class PolygonQueryInterface implements QueryInterface {
  async getGasCosts(tokenSymbol: string): Promise<BigNumberish> {
    const result = await axios("https://api.polygonscan.com/api?module=gastracker&action=gasoracle");
    const { FastGasPrice } = result.data.result.FastGasPrice;
    return parseUnits(FastGasPrice, 9).mul(evmRelayAverageGas).toString();
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
