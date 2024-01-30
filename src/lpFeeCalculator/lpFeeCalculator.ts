// This Util calculates the across realized LP fees. See https://gist.github.com/chrismaree/a713725e4fe96c531c42ed7b629d4a85
// gist for a python implementation of the logic in this file. This implementation is designed to work with both web3.js
// and ethers BNs in the main entry point function calculateRealizedLpFeePct.

import Decimal from "decimal.js";
import { BigNumberish, BN, toBN, toBNWei, fromWei, min, max, fixedPointAdjustment } from "../utils";

// note a similar type exists in the constants file, but are strings only. This is a bit more permissive to allow
// backward compatibility for callers with a rate model defined with bignumbers and not strings.
export interface RateModel {
  UBar: BigNumberish; // denote the utilization kink along the rate model where the slope of the interest rate model changes.
  R0: BigNumberish; // is the interest rate charged at 0 utilization
  R1: BigNumberish; // R_0+R_1 is the interest rate charged at UBar
  R2: BigNumberish; // R_0+R_1+R_2 is the interest rate charged at 100% utilization
}

// converts an APY rate to a one week rate. Uses the Decimal library to take a fractional exponent
function convertApyToWeeklyFee(apy: BN): BN {
  // R_week = (1 + apy)^(1/52) - 1
  const weeklyFeePct = Decimal.pow(
    new Decimal("1").plus(fromWei(apy)),
    new Decimal("1").dividedBy(new Decimal("52"))
  ).minus(new Decimal("1"));

  // Convert from decimal back to BN, scaled by 1e18.
  return toBN(weeklyFeePct.times(fixedPointAdjustment.toString()).floor().toString());
}

export function truncate18DecimalBN(input: BN, digits: number): BN {
  const digitsToDrop = 18 - digits;
  const multiplier = toBN(10).pow(digitsToDrop);
  return input.div(multiplier).mul(multiplier);
}

export class LPFeeCalculator {
  constructor(private readonly rateModel: RateModel) {}

  /**
   * Compute area under curve of the piece-wise linear rate model.
   * @param rateModel Rate model to be used in this calculation.
   * @param utilization The current utilization of the pool.
   * @returns The area under the curve of the piece-wise linear rate model.
   */
  public calculateAreaUnderRateCurve(utilization: BN): BN {
    // Area under first piecewise component
    const utilizationBeforeKink = min(utilization, this.rateModel.UBar);
    const rectangle1Area = utilizationBeforeKink.mul(this.rateModel.R0).div(fixedPointAdjustment);
    const triangle1Area = toBNWei("0.5")
      .mul(this.calculateInstantaneousRate(utilizationBeforeKink).sub(this.rateModel.R0))
      .mul(utilizationBeforeKink)
      .div(fixedPointAdjustment)
      .div(fixedPointAdjustment);

    // Area under second piecewise component
    const utilizationAfter = max(toBN("0"), utilization.sub(this.rateModel.UBar));
    const rectangle2Area = utilizationAfter
      .mul(toBN(this.rateModel.R0).add(this.rateModel.R1))
      .div(fixedPointAdjustment);
    const triangle2Area = toBNWei("0.5")
      .mul(this.calculateInstantaneousRate(utilization).sub(toBN(this.rateModel.R0).add(this.rateModel.R1)))
      .mul(utilizationAfter)
      .div(fixedPointAdjustment)
      .div(fixedPointAdjustment);

    return rectangle1Area.add(triangle1Area).add(rectangle2Area).add(triangle2Area);
  }

  /**
   * Calculate the instantaneous rate for a 0 sized deposit (infinitesimally small).
   * @param utilization The current utilization of the pool.
   * @returns The instantaneous rate for a 0 sized deposit.
   */
  public calculateInstantaneousRate(utilization: BigNumberish): BN {
    // Assuming utilization >= 0, if UBar = 0 then the value beforeKink is 0 since min(>=0, 0) = 0.
    const beforeKink =
      this.rateModel.UBar.toString() === "0"
        ? toBN(0)
        : min(utilization, this.rateModel.UBar).mul(this.rateModel.R1).div(this.rateModel.UBar);
    const afterKink = max(toBN("0"), toBN(utilization).sub(this.rateModel.UBar))
      .mul(this.rateModel.R2)
      .div(toBNWei("1").sub(this.rateModel.UBar));

    return toBN(this.rateModel.R0).add(beforeKink).add(afterKink);
  }

  /**
   * Calculate the realized LP Fee Percent for a given rate model, utilization before and after the deposit.
   * @param rateModel Rate model to be used in this calculation.
   * @param utilizationBeforeDeposit The utilization of the pool before the deposit.
   * @param utilizationAfterDeposit The utilization of the pool after the deposit.
   * @param truncateDecimals Whether to truncate the decimals to 6.
   * @returns The realized LP fee percent.
   */
  public calculateRealizedLpFeePct(
    utilizationBeforeDeposit: BigNumberish,
    utilizationAfterDeposit: BigNumberish,
    truncateDecimals = false
  ): BN {
    const apy = this.calculateApyFromUtilization(toBN(utilizationBeforeDeposit), toBN(utilizationAfterDeposit));

    // ACROSS-V2 UMIP requires that the realized fee percent is floor rounded as decimal to 6 decimals.
    return truncateDecimals ? truncate18DecimalBN(convertApyToWeeklyFee(apy), 6) : convertApyToWeeklyFee(apy);
  }
  /**
   * Calculate the realized yearly LP Fee APY Percent for a given rate model, utilization before and after the deposit.
   * @param rateModel Rate model to be used in this calculation.
   * @param utilizationBeforeDeposit The utilization of the pool before the deposit.
   * @param utilizationAfterDeposit The utilization of the pool after the deposit.
   * @returns The realized LP fee APY percent.
   */
  public calculateApyFromUtilization(utilizationBeforeDeposit: BN, utilizationAfterDeposit: BN): BN {
    if (utilizationBeforeDeposit.eq(utilizationAfterDeposit))
      return this.calculateInstantaneousRate(utilizationBeforeDeposit);

    // Get the area of [0, utilizationBeforeDeposit] and [0, utilizationAfterDeposit]
    const areaBeforeDeposit = this.calculateAreaUnderRateCurve(utilizationBeforeDeposit);
    const areaAfterDeposit = this.calculateAreaUnderRateCurve(utilizationAfterDeposit);

    const numerator = areaAfterDeposit.sub(areaBeforeDeposit);
    const denominator = utilizationAfterDeposit.sub(utilizationBeforeDeposit);
    return numerator.mul(fixedPointAdjustment).div(denominator);
  }
}

/**
 * Calculate the instantaneous rate for a 0 sized deposit (infinitesimally small).
 * @param rateModel Rate model to be used in this calculation.
 * @param utilization The current utilization of the pool.
 * @returns The instantaneous rate for a 0 sized deposit.
 */
export function calculateInstantaneousRate(rateModel: RateModel, utilization: BigNumberish): BN {
  return new LPFeeCalculator(rateModel).calculateInstantaneousRate(utilization);
}

/**
 * Calculate the realized yearly LP Fee APY Percent for a given rate model, utilization before and after the deposit.
 * @param rateModel Rate model to be used in this calculation.
 * @param utilizationBeforeDeposit The utilization of the pool before the deposit.
 * @param utilizationAfterDeposit The utilization of the pool after the deposit.
 * @returns The realized LP fee APY percent.
 */
export function calculateApyFromUtilization(
  rateModel: RateModel,
  utilizationBeforeDeposit: BN,
  utilizationAfterDeposit: BN
): BN {
  return new LPFeeCalculator(rateModel).calculateApyFromUtilization(utilizationBeforeDeposit, utilizationAfterDeposit);
}

/**
 * Calculate the realized LP Fee Percent for a given rate model, utilization before and after the deposit.
 * @param rateModel Rate model to be used in this calculation.
 * @param utilizationBeforeDeposit The utilization of the pool before the deposit.
 * @param utilizationAfterDeposit The utilization of the pool after the deposit.
 * @param truncateDecimals Whether to truncate the decimals to 6.
 * @returns The realized LP fee percent.
 */
export function calculateRealizedLpFeePct(
  rateModel: RateModel,
  utilizationBeforeDeposit: BigNumberish,
  utilizationAfterDeposit: BigNumberish,
  truncateDecimals = false
): BN {
  return new LPFeeCalculator(rateModel).calculateRealizedLpFeePct(
    utilizationBeforeDeposit,
    utilizationAfterDeposit,
    truncateDecimals
  );
}
