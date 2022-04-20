import assert from "assert";
import * as uma from "@uma/sdk";
import { BigNumber } from "ethers";
import { BigNumberish, toBNWei, nativeToToken } from "../utils";
const { percent, fixedPointAdjustment } = uma.across.utils;

// This needs to be implemented for every chain and passed into RelayFeeCalculator
export interface QueryInterface {
  getGasCosts: (tokenSymbol: string) => Promise<BigNumberish>;
  getTokenPrice: (tokenSymbol: string) => Promise<number | string>;
  getTokenDecimals: (tokenSymbol: string) => Promise<number>;
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
