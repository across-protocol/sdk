import { BigNumber, ethers } from "ethers";
import * as uma from "@uma/sdk";
import Decimal from "decimal.js";

export type BigNumberish = string | number | BigNumber;
export type BN = BigNumber;
export type Decimalish = string | number | Decimal;
export const AddressZero = ethers.constants.AddressZero;

const { ConvertDecimals } = uma.utils;

/**
 * toBN.
 *
 * @param {BigNumberish} num
 * @returns {BN}
 */
export const toBN = (num: BigNumberish): BN => BigNumber.from(num.toString());

/**
 * toBNWei.
 *
 * @param {BigNumberish} num
 * @param {number} decimals
 * @returns {BN}
 */
export const toBNWei = (num: BigNumberish, decimals?: number): BN => ethers.utils.parseUnits(num.toString(), decimals);

/**
 * fromWei.
 *
 * @param {BigNumberish} num
 * @param {number} decimals
 * @returns {string}
 */
export const fromWei = (num: BigNumberish, decimals?: number): string =>
  ethers.utils.formatUnits(num.toString(), decimals);

/**
 * min.
 *
 * @param {BigNumberish} a
 * @param {BigNumberish} b
 * @returns {BN}
 */
export function min(a: BigNumberish, b: BigNumberish): BN {
  const bna = toBN(a);
  const bnb = toBN(b);
  return bna.lte(bnb) ? bna : bnb;
}
/**
 * max.
 *
 * @param {BigNumberish} a
 * @param {BigNumberish} b
 * @returns {BN}
 */
export function max(a: BigNumberish, b: BigNumberish): BN {
  const bna = toBN(a);
  const bnb = toBN(b);
  return bna.gte(bnb) ? bna : bnb;
}

export const fixedPointAdjustment = toBNWei("1");

/**
 * Convert an amount of native gas token into a token given price and token decimals.
 *
 * @param {BigNumberish} fromAmount - Amount of native gas token to convert.
 * @param {string | number} [ price=1 ] - The price as native gas token per token, ie how much native gas token can 1 token buy.
 * @param {} [ toDecimals=18 ] - Number of decimals for the token currency.
 * @param {} [ nativeDecimals=18 ] - Number of decimals for the native token currency.
 * @returns {string} The number of tokens denominated in token decimals in the smallest unit (wei).
 */
export function nativeToToken(
  fromAmount: BigNumberish,
  price: string | number = 1,
  toDecimals = 18,
  nativeDecimals = 18
): string {
  const priceWei = toBNWei(price);
  const toAmount = toBNWei(fromAmount).div(priceWei);
  return ConvertDecimals(nativeDecimals, toDecimals)(toAmount);
}

/**
 * Convert a gas amount and gas price to wei.
 *
 * @param {number} gas - gas amount.
 * @param {BigNumberish} gasPrice - gas price in gwei.
 * @returns {BigNumber} - total fees in wei.
 */
export const gasCost = (gas: BigNumberish, gasPrice: BigNumberish): BigNumber => {
  return BigNumber.from(gas).mul(gasPrice);
};

/**
 * getGasFees. Low level pure function call to calculate gas fees.
 *
 * @param {number} gas - The gast cost for transfer, use constants defined in file.
 * @param {BigNumberish} gasPrice - Estimated gas price in wei.
 * @param {string | number} [price = 1] - The price of the token in native gas token, how much native gas token can 1 token buy.
 * @param {number} [decimals=18] - Number of decimals of token.
 * @returns {string} - The value of fees native to the token provided, in its smallest unit.
 */
export function calculateGasFees(
  gas: number,
  gasPrice: BigNumberish,
  price: string | number = 1,
  decimals = 18
): string {
  const amountNative = gasCost(gas, gasPrice);
  return nativeToToken(amountNative, price, decimals);
}

/**
 * percent.
 *
 * @param {BigNumberish} numerator
 * @param {BigNumberish} denominator
 * @returns {BN}
 */
export function percent(numerator: BigNumberish, denominator: BigNumberish): BN {
  return fixedPointAdjustment.mul(numerator).div(denominator);
}

/**
 * calcContinuousCompoundInterest. From https://www.calculatorsoup.com/calculators/financial/compound-interest-calculator.php?given_data=find_r&A=2&P=1&n=0&t=1&given_data_last=find_r&action=solve
 * Returns a yearly interest rate if start/end amount had been continuously compounded over the period elapsed. Multiply result by 100 for a %.
 *
 * @param {string} startAmount
 * @param {string} endAmount
 * @param {string} periodsElapsed
 * @param {string} periodsPerYear
 */
export const calcContinuousCompoundInterest = (
  startAmount: Decimalish,
  endAmount: Decimalish,
  periodsElapsed: Decimalish,
  periodsPerYear: Decimalish
): string => {
  const years = new Decimal(periodsPerYear).div(periodsElapsed);
  return new Decimal(endAmount)
    .div(startAmount)
    .ln()
    .div(years)
    .toString();
};
/**
 * calcPeriodicCompoundInterest. Taken from https://www.calculatorsoup.com/calculators/financial/compound-interest-calculator.php?given_data=find_r&A=2&P=1&n=365&t=1&given_data_last=find_r&action=solve
 * This will return a periodically compounded interest rate for 1 year. Multiply result by 100 for a %.
 *
 * @param {string} startAmount - Starting amount or price
 * @param {string} endAmount - Ending amount or price
 * @param {string} periodsElapsed - How many periods elapsed for the start and end amount.
 * @param {string} periodsPerYear - How many periods in 1 year.
 */
export const calcPeriodicCompoundInterest = (
  startAmount: Decimalish,
  endAmount: Decimalish,
  periodsElapsed: Decimalish,
  periodsPerYear: Decimalish
): string => {
  const n = new Decimal(periodsPerYear);
  const A = new Decimal(endAmount);
  const P = new Decimal(startAmount);
  const t = new Decimal(periodsPerYear).div(periodsElapsed);
  const one = new Decimal(1);
  return n
    .mul(
      A.div(P)
        .pow(one.div(n.div(t)))
        .sub(one)
    )
    .toString();
};

/**
 * calcApr. Simple apr calculation based on extrapolating the difference for a short period over a year.
 *
 * @param {Decimalish} startAmount - Starting amount or price
 * @param {Decimalish} endAmount - Ending amount or price
 * @param {Decimalish} periodsElapsed - periods elapsed from start to end
 * @param {Decimalish} periodsPerYear - periods per year
 */
export const calcApr = (
  startAmount: Decimalish,
  endAmount: Decimalish,
  periodsElapsed: Decimalish,
  periodsPerYear: Decimalish
): string => {
  return new Decimal(endAmount)
    .sub(startAmount)
    .div(startAmount)
    .mul(periodsPerYear)
    .div(periodsElapsed)
    .toString();
};
/**
 * Takes two values and returns a list of number intervals
 *
 * @example
 * ```js
 * getSamplesBetween(1, 9, 3) //returns [[1, 3], [4, 7], [8, 9]]
 * ```
 */
export const getSamplesBetween = (min: number, max: number, size: number) => {
  let keepIterate = true;
  const intervals = [];

  while (keepIterate) {
    const to = Math.min(min + size - 1, max);
    intervals.push([min, to]);
    min = to + 1;
    if (min >= max) keepIterate = false;
  }

  return intervals;
};


export async function delay(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function retry<T>(call: () => Promise<T>, times: number, delayS: number): Promise<T> {
  if (times <= 1) {
    return call();
  } else {
    return retry(() => call().catch(async () => {
      await delay(delayS);
      return call();
    }), times - 1, delayS);
  }
}