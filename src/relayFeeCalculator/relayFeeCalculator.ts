import assert from "assert";
import * as uma from "@uma/sdk";
import { BigNumber } from "ethers";
import { BigNumberish, toBNWei, nativeToToken, toBN, min, max } from "../utils";
const { percent, fixedPointAdjustment } = uma.across.utils;

// This needs to be implemented for every chain and passed into RelayFeeCalculator
export interface QueryInterface {
  getGasCosts: (tokenSymbol: string) => Promise<BigNumberish>;
  getTokenPrice: (tokenSymbol: string, coingeckoProApiKey?: string) => Promise<number>;
  getTokenDecimals: (tokenSymbol: string) => number;
}

export const expectedCapitalCostsKeys = ["lowerBound", "upperBound", "cutoff", "decimals"];
export interface CapitalCostConfig {
  lowerBound: string;
  upperBound: string;
  cutoff: string;
  decimals: number;
}
export interface RelayFeeCalculatorConfig {
  nativeTokenDecimals?: number;
  gasDiscountPercent?: number;
  capitalDiscountPercent?: number;
  feeLimitPercent?: number;
  capitalCostsPercent?: number;
  capitalCostsConfig?: { [token: string]: CapitalCostConfig };
  queries: QueryInterface;
}

export class RelayFeeCalculator {
  private queries: Required<RelayFeeCalculatorConfig>["queries"];
  private gasDiscountPercent: Required<RelayFeeCalculatorConfig>["gasDiscountPercent"];
  private capitalDiscountPercent: Required<RelayFeeCalculatorConfig>["capitalDiscountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  private nativeTokenDecimals: Required<RelayFeeCalculatorConfig>["nativeTokenDecimals"];
  private capitalCostsPercent: Required<RelayFeeCalculatorConfig>["capitalCostsPercent"];
  private capitalCostsConfig: Required<RelayFeeCalculatorConfig>["capitalCostsConfig"];
  constructor(config: RelayFeeCalculatorConfig) {
    this.queries = config.queries;
    this.gasDiscountPercent = config.gasDiscountPercent || 0;
    this.capitalDiscountPercent = config.capitalDiscountPercent || 0;
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
    this.capitalCostsConfig = config.capitalCostsConfig || {};
    for (const token of Object.keys(this.capitalCostsConfig)) {
      RelayFeeCalculator.validateCapitalCostsConfig(this.capitalCostsConfig[token]);
    }
  }

  static validateCapitalCostsConfig(capitalCosts: CapitalCostConfig) {
    assert(toBN(capitalCosts.upperBound).lt(toBNWei("0.01")), "upper bound must be < 1%");
    assert(toBN(capitalCosts.lowerBound).lte(capitalCosts.upperBound), "lower bound must be <= upper bound");
    assert(capitalCosts.decimals > 0 && capitalCosts.decimals <= 18, "invalid decimals");
  }

  async getTokenPrice(tokenSymbol: string, coingeckoProApiKey?: string): Promise<number> {
    return this.queries.getTokenPrice(tokenSymbol, coingeckoProApiKey);
  }

  async gasFeePercent(amountToRelay: BigNumberish, tokenSymbol: string, _tokenPrice?: number): Promise<BigNumber> {
    const getGasCosts = this.queries.getGasCosts(tokenSymbol).catch((error) => {
      console.error(`ERROR(gasFeePercent): Error while fetching gas costs ${error}`);
      throw error;
    });
    const getTokenPrice = this.queries.getTokenPrice(tokenSymbol).catch((error) => {
      console.error(`ERROR(gasFeePercent): Error while fetching token price ${error}`);
      throw error;
    });
    const results = await Promise.all(_tokenPrice !== undefined ? [getGasCosts, getTokenPrice] : [getGasCosts]);
    const gasCosts = results[0];
    const tokenPrice = (_tokenPrice !== undefined ? _tokenPrice : results[1]) as number;
    const decimals = this.queries.getTokenDecimals(tokenSymbol);
    const gasFeesInToken = nativeToToken(gasCosts, tokenPrice, decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, amountToRelay);
  }

  // Note: these variables are unused now, but may be needed in future versions of this function that are more complex.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async capitalFeePercent(_amountToRelay: BigNumberish, _tokenSymbol: string): Promise<BigNumber> {
    // V0: Charge fixed capital fee
    const defaultFee = toBNWei(this.capitalCostsPercent / 100);

    // V1: Charge fee that scales with size. This will charge a fee % based on a linear fee curve with a "kink" at a
    // cutoff in the same units as _amountToRelay. Before the kink, the fee % will increase linearly from a lower
    // bound to an upper bound. After the kink, the fee % increase will be fixed, and slowly approach the upper bound
    // for very large amount inputs.
    if (this.capitalCostsConfig[_tokenSymbol]) {
      const config = this.capitalCostsConfig[_tokenSymbol];
      // Scale amount "y" to 18 decimals
      const y = toBN(_amountToRelay).mul(toBNWei("1", 18 - config.decimals));
      // At a minimum, the fee will be equal to lower bound fee * y
      const minCharge = toBN(config.lowerBound).mul(y).div(fixedPointAdjustment);

      // Charge an increasing marginal fee % up to min(cutoff, y). If y is very close to the cutoff, the fee %
      // will be equal to half the sum of (upper bound + lower bound).
      const yTriangle = min(config.cutoff, y);

      // triangleSlope is slope of fee curve from lower bound to upper bound.
      // triangleCharge is interval of curve from 0 to y for curve = triangleSlope * y
      const triangleSlope = toBN(config.upperBound).sub(config.lowerBound).mul(fixedPointAdjustment).div(config.cutoff);
      const triangleHeight = triangleSlope.mul(yTriangle).div(fixedPointAdjustment);
      const triangleCharge = triangleHeight.mul(yTriangle).div(toBNWei(2));

      // For any amounts above the cutoff, the marginal fee % will not increase but will be fixed at the upper bound
      // value.
      const yRemainder = max(toBN(0), y.sub(config.cutoff));
      const remainderCharge = yRemainder.mul(toBN(config.upperBound).sub(config.lowerBound)).div(fixedPointAdjustment);

      return minCharge.add(triangleCharge).add(remainderCharge).mul(fixedPointAdjustment).div(y);
    }

    return defaultFee;
  }
  async relayerFeeDetails(amountToRelay: BigNumberish, tokenSymbol: string, tokenPrice?: number) {
    let isAmountTooLow = false;
    const gasFeePercent = await this.gasFeePercent(amountToRelay, tokenSymbol, tokenPrice);
    console.log(
      `INFO(relayerFeeDetails): Computed gasFeePercent ${gasFeePercent}, overrode optional tokenPrice param: ${
        tokenPrice !== undefined
      }`
    );
    const gasFeeTotal = gasFeePercent.mul(amountToRelay).div(fixedPointAdjustment);
    const capitalFeePercent = await this.capitalFeePercent(amountToRelay, tokenSymbol);
    console.log(`INFO(relayerFeeDetails): Computed capitalFeePercent ${capitalFeePercent}`);
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
