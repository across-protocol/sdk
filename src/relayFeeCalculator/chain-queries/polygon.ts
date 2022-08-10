import { DEFAULT_LOGGER, Logger, QueryInterface } from "../relayFeeCalculator";
import {
  BigNumberish,
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
} from "../../utils";
import { providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { SpokePool__factory, SpokePool } from "@across-protocol/contracts-v2";

export class PolygonQueries implements QueryInterface {
  private spokePool: SpokePool;

  constructor(
    readonly provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    readonly spokePoolAddress = "0x69B5c72837769eF1e7C164Abc6515DcFf217F920",
    readonly usdcAddress = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    readonly simulatedRelayerAddress = "0x893d0D70AD97717052E3AA8903D9615804167759",
    private readonly coingeckoProApiKey?: string,
    private readonly logger: Logger = DEFAULT_LOGGER
  ) {
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(): Promise<BigNumberish> {
    const tx = await createUnsignedFillRelayTransaction(this.spokePool, this.usdcAddress, this.simulatedRelayerAddress);
    return estimateTotalGasRequiredByUnsignedTransaction(tx, this.simulatedRelayerAddress, this.provider);
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
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
