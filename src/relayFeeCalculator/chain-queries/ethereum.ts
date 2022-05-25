import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { Coingecko } from "../../coingecko/Coingecko";
import { providers, BigNumber } from "ethers";

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
  OETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  AETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  KOV: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  KOR: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  ARETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
  },
  UMA: {
    address: "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828",
    decimals: 18,
  },
  WBTC: {
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 8,
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

export const defaultAverageGas = 116006;

export class EthereumQueries implements QueryInterface {
  constructor(
    public readonly provider: providers.Provider,
    public readonly averageGas = defaultAverageGas,
    readonly symbolMapping = SymbolMapping
  ) {}
  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    return BigNumber.from(await this.provider.getGasPrice())
      .mul(this.averageGas)
      .toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const [, price] = await Coingecko.get().getCurrentPriceByContract(this.symbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
