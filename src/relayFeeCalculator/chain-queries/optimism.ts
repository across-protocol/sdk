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

import { L2Provider, asL2Provider } from "@eth-optimism/sdk";

export class OptimismQueries implements QueryInterface {
  private spokePool: SpokePool;
  readonly provider: L2Provider<providers.Provider>;

  constructor(
    provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    spokePoolAddress = "0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9",
    private readonly usdcAddress = "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    private readonly simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759",
    private readonly coingeckoProApiKey?: string,
    private readonly logger: Logger = DEFAULT_LOGGER,
    readonly gasMarkup: number = 0
  ) {
    this.provider = asL2Provider(provider);
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
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
