import assert from "assert";
import * as uma from "@uma/sdk";
import { Provider } from "@ethersproject/providers";
import { BigNumber } from "ethers";
import { BigNumberish, toBNWei, nativeToToken, gasCost } from "../utils";
const { percent, fixedPointAdjustment } = uma.across.utils;

export interface QueryInterface {
  getGasCosts: (tokenSymbol: string) => Promise<BigNumberish>;
  getTokenPrice: (tokenSymbol: string) => Promise<number | string>;
  getTokenDecimals: (tokenSymbol: string) => Promise<number>;
}

// Example of how to write this query class
export class ExampleQueries implements QueryInterface {
  // private coingecko: uma.Coingecko;
  /**
   * constructor.
   *
   * @param {Provider} provider - For the default query class, the provider is for the destination chain.
   * @param {string} priceSymbol - The symbol of the native gas token on the destination chain.
   * @param {} defaultGas - hardcoded gas required to submit a relay on the destination chain.
   */
  constructor(private provider: Provider, private defaultGas = "305572") {}
  /**
   * getGasCosts. This should calculate how much of the native gas token is used for a relay on the destination chain.
   *
   * @returns {Promise<BigNumberish>}
   */
  async getGasCosts(): Promise<BigNumberish> {
    const { gasPrice, maxFeePerGas } = await this.provider.getFeeData();
    const price = maxFeePerGas || gasPrice;
    assert(price, "Unable to get gas price");
    return gasCost(this.defaultGas, price);
  }
  /**
   * getTokenPrice. This should return the price of a token relative to the native gas token on the
   * destination chain. This is tricky because the token address provided should be the token address
   * on the destination chain, which may not be easily accessible when sending relay.
   *
   * @param {string} tokenSymbol
   * @returns {Promise<number | string>}
   */
  async getTokenPrice(): Promise<number | string> {
    return 1;
  }
  /**
   * getTokenDecimals. Gets token decimals, its assumed decimals are the same on both chains.
   *
   * @param {string} tokenSymbol
   * @returns {Promise<number>}
   */
  async getTokenDecimals(): Promise<number> {
    return 18;
  }
}

export interface RelayFeeCalculatorConfig {
  nativeTokenDecimals?: number;
  discountPercent?: number;
  feeLimitPercent?: number;
  queries: QueryInterface;
}

export class RelayFeeCalculator {
  private queries: Required<RelayFeeCalculatorConfig>["queries"];
  private discountPercent: Required<RelayFeeCalculatorConfig>["discountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  private nativeTokenDecimals: Required<RelayFeeCalculatorConfig>["nativeTokenDecimals"];
  constructor(config: RelayFeeCalculatorConfig) {
    this.queries = config.queries;
    this.discountPercent = config.discountPercent || 0;
    this.feeLimitPercent = config.feeLimitPercent || 0;
    this.nativeTokenDecimals = config.nativeTokenDecimals || 18;
    assert(
      this.discountPercent >= 0 && this.discountPercent <= 100,
      "discountPercent must be between 0 and 100 percent"
    );
    assert(
      this.feeLimitPercent >= 0 && this.feeLimitPercent <= 100,
      "feeLimitPercent must be between 0 and 100 percent"
    );
  }
  async relayerFeePercent(amountToRelay: BigNumberish, tokenSymbol: string): Promise<BigNumberish> {
    const gasCosts = await this.queries.getGasCosts(tokenSymbol);
    const tokenPrice = await this.queries.getTokenPrice(tokenSymbol);
    const decimals = await this.queries.getTokenDecimals(tokenSymbol);
    const gasFeesInToken = nativeToToken(gasCosts, tokenPrice, decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, amountToRelay).toString();
  }
  async relayerFeeDetails(amountToRelay: BigNumberish, tokenSymbol: string) {
    let isAmountTooLow = false;
    const relayFeePercent = await this.relayerFeePercent(amountToRelay, tokenSymbol);
    const relayFeeTotal = BigNumber.from(relayFeePercent)
      .mul(amountToRelay)
      .div(fixedPointAdjustment)
      .toString();
    if (this.feeLimitPercent) {
      isAmountTooLow = BigNumber.from(relayFeePercent).gt(toBNWei(this.feeLimitPercent / 100));
    }
    return {
      amountToRelay: amountToRelay.toString(),
      tokenSymbol,
      relayFeePercent,
      relayFeeTotal,
      discountPercent: this.discountPercent,
      feeLimitPercent: this.feeLimitPercent,
      isAmountTooLow,
    };
  }
}
