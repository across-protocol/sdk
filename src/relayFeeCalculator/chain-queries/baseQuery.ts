/* eslint-disable @typescript-eslint/no-unused-vars */
import { SpokePool, SpokePool__factory } from "@across-protocol/contracts-v2";
import { L2Provider as L2OptimismWrap } from "@eth-optimism/sdk";
import { providers } from "ethers";
import { SymbolMappingType } from ".";
import Coingecko from "../../coingecko/Coingecko";
import {
  BigNumberish,
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
} from "../../utils";
import { QueryInterface } from "../relayFeeCalculator";

type Provider = providers.Provider;

/**
 * An abstract base class for querying a blockchain for
 * a symbol's decimals, token price, and estimated gas costs
 * of running a fillRelay function.
 */
export abstract class BaseQuery implements QueryInterface {
  readonly spokePool: SpokePool;

  protected constructor(
    readonly provider: Provider | L2OptimismWrap<Provider>,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePoolAddress: string,
    readonly usdcAddress: string,
    readonly simulatedRelayerAddress: string,
    readonly gasMultiplier: number = 0.0,
    readonly fixedGasCost: BigNumberish | undefined = undefined,
    readonly coinGeckoBaseCurrency: string = "eth"
  ) {
    this.spokePool = SpokePool__factory.connect(this.spokePoolAddress, this.provider);
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const [, price] = await Coingecko.get().getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].address,
      this.coinGeckoBaseCurrency
    );
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const tx = await createUnsignedFillRelayTransaction(this.spokePool, this.usdcAddress, this.simulatedRelayerAddress);
    return estimateTotalGasRequiredByUnsignedTransaction(
      tx,
      this.simulatedRelayerAddress,
      this.provider,
      this.gasMultiplier,
      this.fixedGasCost
    );
  }
}
