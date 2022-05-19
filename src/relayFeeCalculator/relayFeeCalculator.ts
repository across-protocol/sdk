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
  gasDiscountPercent?: number;
  capitalDiscountPercent?: number;
  feeLimitPercent?: number;
  capitalCostsPercent?: number;
  queries: QueryInterface;
}

export class RelayFeeCalculator {
  private queries: Required<RelayFeeCalculatorConfig>["queries"];
  private gasDiscountPercent: Required<RelayFeeCalculatorConfig>["gasDiscountPercent"];
  private capitalDiscountPercent: Required<RelayFeeCalculatorConfig>["capitalDiscountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  private nativeTokenDecimals: Required<RelayFeeCalculatorConfig>["nativeTokenDecimals"];
  private capitalCostsPercent: Required<RelayFeeCalculatorConfig>["capitalCostsPercent"];
  constructor(config: RelayFeeCalculatorConfig) {
    this.queries = config.queries;
    this.gasDiscountPercent = config.gasDiscountPercent || 0;
    this.capitalDiscountPercent = config.capitalCostsPercent || 0;
    this.feeLimitPercent = config.feeLimitPercent || 0;
    this.nativeTokenDecimals = config.nativeTokenDecimals || 18;
    this.capitalCostsPercent = config.capitalCostsPercent || 0;
    assert(
      this.gasDiscountPercent >= 0 && this.gasDiscountPercent <= 100,
      "gasDiscountPercent must be between 0 and 100 percent"
    );
    assert(
      this.capitalDiscountPercent >= 0 && this.capitalDiscountPercent <= 100,
      "capitalDiscountPercent must be between 0 and 100 percent"
    );
    assert(
      this.feeLimitPercent >= 0 && this.feeLimitPercent <= 100,
      "feeLimitPercent must be between 0 and 100 percent"
    );
    assert(
      this.capitalCostsPercent >= 0 && this.capitalCostsPercent <= 100,
      "capitalCostsPercent must be between 0 and 100 percent"
    );
  }
  async gasFeePercent(amountToRelay: BigNumberish, tokenSymbol: string): Promise<BigNumber> {
    const [gasCosts, tokenPrice, decimals] = await Promise.all([
      this.queries.getGasCosts(tokenSymbol),
      this.queries.getTokenPrice(tokenSymbol),
      this.queries.getTokenDecimals(tokenSymbol),
    ]);
    const gasFeesInToken = nativeToToken(gasCosts, tokenPrice, decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, amountToRelay);
  }

  // Note: these variables are unused now, but may be needed in future versions of this function that are more complex.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async capitalFeePercent(_amountToRelay: BigNumberish, _tokenSymbol: string): Promise<BigNumber> {
    return toBNWei(this.capitalCostsPercent / 100);
  }
  async relayerFeeDetails(amountToRelay: BigNumberish, tokenSymbol: string) {
    let isAmountTooLow = false;
    const gasFeePercent = await this.gasFeePercent(amountToRelay, tokenSymbol);
    const gasFeeTotal = gasFeePercent.mul(amountToRelay).div(fixedPointAdjustment);
    const capitalFeePercent = await this.capitalFeePercent(amountToRelay, tokenSymbol);
    const capitalFeeTotal = capitalFeePercent.mul(amountToRelay).div(fixedPointAdjustment);
    const relayFeePercent = gasFeePercent.add(capitalFeePercent);
    const relayFeeTotal = gasFeeTotal.add(capitalFeeTotal);

    if (this.feeLimitPercent) {
      isAmountTooLow = gasFeePercent.add(capitalFeePercent).gt(toBNWei(this.feeLimitPercent / 100));
    }
    return {
      amountToRelay: amountToRelay.toString(),
      tokenSymbol,
      gasFeePercent: gasFeePercent.toString(),
      gasFeeTotal: gasFeeTotal.toString(),
      gasDiscountPercent: this.gasDiscountPercent,
      capitalFeePercent: capitalFeePercent.toString(),
      capitalFeeTotal: capitalFeeTotal.toString(),
      capitalDiscountPercent: this.capitalDiscountPercent,
      relayFeePercent: relayFeePercent.toString(),
      relayFeeTotal: relayFeeTotal.toString(),
      feeLimitPercent: this.feeLimitPercent,
      isAmountTooLow,
    };
  }
}
