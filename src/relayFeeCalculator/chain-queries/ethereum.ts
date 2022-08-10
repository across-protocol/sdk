import { DEFAULT_LOGGER, Logger, QueryInterface } from "../relayFeeCalculator";
import {
  BigNumberish,
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
} from "../../utils";
import { Coingecko } from "../../coingecko/Coingecko";
import { providers } from "ethers";
import { SpokePool__factory, SpokePool } from "@across-protocol/contracts-v2";

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

export class EthereumQueries implements QueryInterface {
  private spokePool: SpokePool;

  constructor(
    readonly provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    readonly spokePoolAddress = "0x4D9079Bb4165aeb4084c526a32695dCfd2F77381",
    readonly usdcAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    readonly simulatedRelayerAddress = "0x893d0D70AD97717052E3AA8903D9615804167759",
    private readonly coingeckoProApiKey?: string,
    private readonly logger: Logger = DEFAULT_LOGGER,
    readonly gasMarkup: number = 0
  ) {
    this.spokePool = SpokePool__factory.connect(this.spokePoolAddress, this.provider);
  }
  async getGasCosts(): Promise<BigNumberish> {
    const tx = await createUnsignedFillRelayTransaction(this.spokePool, this.usdcAddress, this.simulatedRelayerAddress);
    return estimateTotalGasRequiredByUnsignedTransaction(
      tx,
      this.simulatedRelayerAddress,
      this.provider,
      this.gasMarkup
    );
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, price] = await coingeckoInstance.getCurrentPriceByContract(this.symbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  getTokenDecimals(tokenSymbol: string): number {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
