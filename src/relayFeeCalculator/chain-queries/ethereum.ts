import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { Coingecko } from "../../coingecko/Coingecko";
import { utils } from "ethers";
import axios from "axios";

const { parseUnits } = utils;

// Note: these are the mainnet addresses for these symbols meant to be used for pricing.
export const SymbolMapping: { [symbol: string]: { address: string; decimals: number } } = {
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  WETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  ETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  UMA: {
    address: "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828",
    decimals: 18,
  },
  WBTC: {
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 18,
  },
  BADGER: {
    address: "0x3472A5A71965499acd81997a54BBA8D852C6E53d",
    decimals: 18,
  },
  BOBA: {
    address: "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc",
    decimals: 18,
  },
  DAI: {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
  },
  MATIC: {
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    decimals: 18,
  },
  WMATIC: {
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    decimals: 18,
  },
};

export const defaultAverageGas = 50000;

export class EthereumQueries implements QueryInterface {
  constructor(public readonly averageGas = defaultAverageGas) {}
  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const result = await axios("https://api.etherscan.io/api?module=gastracker&action=gasoracle");
    const { FastGasPrice } = result.data.result;
    return parseUnits(FastGasPrice, 9).mul(this.averageGas).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    const [, price] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    return SymbolMapping[tokenSymbol].decimals;
  }
}
