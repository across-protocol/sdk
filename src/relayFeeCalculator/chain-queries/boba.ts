import { QueryInterface } from "../relayFeeCalculator";
import {
  BigNumberish,
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
} from "../../utils";
import { utils, providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { SpokePool__factory, SpokePool } from "@across-protocol/contracts-v2";

const { parseUnits } = utils;

export class BobaQueries implements QueryInterface {
  private spokePool: SpokePool;

  constructor(
    readonly provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    spokePoolAddress = "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58",
    private readonly usdcAddress = "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    private readonly simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759"
  ) {
    // TODO: replace with address getter.
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const tx = await createUnsignedFillRelayTransaction(this.spokePool, this.usdcAddress, this.simulatedRelayerAddress);
    return estimateTotalGasRequiredByUnsignedTransaction(
      tx,
      this.simulatedRelayerAddress,
      this.provider,
      parseUnits("1", 9)
    );
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
