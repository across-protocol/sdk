import { QueryInterface } from "../relayFeeCalculator";
import {
  BigNumberish,
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
} from "../../utils";
import { providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { SpokePool__factory, SpokePool } from "@across-protocol/contracts-v2";

export class ArbitrumQueries implements QueryInterface {
  private spokePool: SpokePool;

  constructor(
    readonly provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    spokePoolAddress = "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
    private readonly usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    private readonly simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759"
  ) {
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const tx = await createUnsignedFillRelayTransaction(this.spokePool, this.usdcAddress, this.simulatedRelayerAddress);
    return estimateTotalGasRequiredByUnsignedTransaction(tx, this.simulatedRelayerAddress, this.provider);
  }

  async getTokenPrice(tokenSymbol: string, coingeckoProApiKey?: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = coingeckoProApiKey !== undefined ? Coingecko.getPro(coingeckoProApiKey) : Coingecko.get();
    const [, price] = await coingeckoInstance.getCurrentPriceByContract(this.symbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  getTokenDecimals(tokenSymbol: string): number {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
