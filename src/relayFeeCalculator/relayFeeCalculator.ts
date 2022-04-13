import assert from "assert";
import * as uma from "@uma/sdk";
import { Provider } from "@ethersproject/providers";
import { BigNumber } from "ethers";
import { BigNumberish, calculateGasFees, toBNWei } from "../utils";
const Coingecko = uma.Coingecko;
const { percent, fixedPointAdjustment } = uma.across.utils;
const { connect: erc20Connect } = uma.clients.erc20;

export interface QueryInterface {
  getGas: (tokenAddress?: string) => Promise<BigNumberish>;
  getGasPrice: () => Promise<BigNumberish>;
  getTokenPrice: (tokenAddress: string) => Promise<number | string>;
  getTokenDecimals: (tokenAddress: string) => Promise<number>;
}

// Override this to add different behaviors for different chains.
export class DefaultQueries implements QueryInterface {
  private coingecko: uma.Coingecko;
  constructor(private provider: Provider, private priceSymbol: string = "eth", private defaultGas = "305572") {
    this.coingecko = new Coingecko();
  }
  async getGas(): Promise<BigNumberish> {
    return this.defaultGas;
  }
  async getGasPrice(): Promise<BigNumberish> {
    const { gasPrice, maxFeePerGas } = await this.provider.getFeeData();
    const result = maxFeePerGas || gasPrice;
    assert(result, "Unable to get gas price");
    return result;
  }
  async getTokenPrice(tokenAddress: string): Promise<number | string> {
    const [, tokenPrice] = await this.coingecko.getCurrentPriceByContract(tokenAddress, this.priceSymbol.toLowerCase());
    return tokenPrice;
  }
  async getTokenDecimals(tokenAddress: string): Promise<number> {
    const erc20Client = erc20Connect(tokenAddress, this.provider);
    return erc20Client.decimals();
  }
}

interface RelayFeeCalculatorConfig {
  discountPercent?: number;
  feeLimitPercent?: number;
  queries: QueryInterface;
}

export class RelayFeeCalculator {
  private queries: Required<RelayFeeCalculatorConfig>["queries"];
  private discountPercent: Required<RelayFeeCalculatorConfig>["discountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  constructor(config: RelayFeeCalculatorConfig) {
    this.queries = config.queries;
    this.discountPercent = config.discountPercent || 0;
    this.feeLimitPercent = config.feeLimitPercent || 0;
    assert(
      this.discountPercent >= 0 && this.discountPercent <= 100,
      "discountPercent must be between 0 and 100 percent"
    );
    assert(
      this.feeLimitPercent >= 0 && this.feeLimitPercent <= 100,
      "feeLimitPercent must be between 0 and 100 percent"
    );
  }
  async relayerFeePercent(amountToRelay: BigNumberish, tokenAddress?: string): Promise<BigNumberish> {
    const gas = await this.queries.getGas(tokenAddress);
    const gasPrice = await this.queries.getGasPrice();
    if (!tokenAddress) {
      const gasFees = calculateGasFees(gas, gasPrice);
      return percent(gasFees, amountToRelay).toString();
    }
    const tokenPrice = await this.queries.getTokenPrice(tokenAddress);
    const decimals = await this.queries.getTokenDecimals(tokenAddress);
    const gasFees = calculateGasFees(gas, gasPrice, tokenPrice, decimals);
    return percent(gasFees, amountToRelay).toString();
  }
  async relayerFeeDetails(amountToRelay: BigNumberish, tokenAddress?: string) {
    let isAmountTooLow = false;
    const relayFeePercent = await this.relayerFeePercent(amountToRelay, tokenAddress);
    const relayFeeTotal = BigNumber.from(relayFeePercent)
      .mul(amountToRelay)
      .div(fixedPointAdjustment)
      .toString();
    if (this.feeLimitPercent) {
      isAmountTooLow = BigNumber.from(relayFeePercent).gt(toBNWei(this.feeLimitPercent / 100));
    }
    return {
      amountToRelay: amountToRelay.toString(),
      relayFeePercent,
      relayFeeTotal,
      discountPercent: this.discountPercent,
      feeLimitPercent: this.feeLimitPercent,
      tokenAddress,
      isAmountTooLow,
    };
  }
}
