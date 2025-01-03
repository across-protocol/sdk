import Decimal from "decimal.js";
import { ethers } from "ethers";
import { BigNumber, BigNumberish, BN, formatUnits, parseUnits, toBN } from "./BigNumberUtils";
import { ConvertDecimals } from "./FormattingUtils";

export type Decimalish = string | number | Decimal;
export const AddressZero = ethers.constants.AddressZero;
export const MAX_BIG_INT = BigNumber.from(Number.MAX_SAFE_INTEGER.toString());

/**
 * toBNWei.
 *
 * @param {BigNumberish} num
 * @param {number} decimals
 * @returns {BN}
 */
export const toBNWei = (num: BigNumberish, decimals?: number): BN => parseUnits(num.toString(), decimals);

/**
 * fromWei.
 *
 * @param {BigNumberish} num
 * @param {number} decimals
 * @returns {string}
 */
export const fromWei = (num: BigNumberish, decimals?: number): string => formatUnits(num.toString(), decimals);

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
  return ConvertDecimals(nativeDecimals, toDecimals)(toAmount).toString();
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
  return new Decimal(endAmount).div(startAmount).ln().div(years).toString();
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
    .toFixed(18);
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
  return new Decimal(endAmount).sub(startAmount).div(startAmount).mul(periodsPerYear).div(periodsElapsed).toFixed(18);
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

/**
 * A promise that resolves after a specified number of seconds
 * @param seconds The number of seconds to wait
 */
export function delay(seconds: number) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Attempt to retry a function call a number of times with a delay between each attempt
 * @param call The function to call
 * @param times The number of times to retry
 * @param delayS The number of seconds to delay between each attempt
 * @returns The result of the function call.
 */
export function retry<T>(call: () => Promise<T>, times: number, delayS: number): Promise<T> {
  let promiseChain = call();
  for (let i = 0; i < times; i++)
    promiseChain = promiseChain.catch(async () => {
      await delay(delayS);
      return await call();
    });
  return promiseChain;
}

export type TransactionCostEstimate = {
  nativeGasCost: BigNumber; // Units: gas
  tokenGasCost: BigNumber; // Units: wei (nativeGasCost * wei/gas)
  gasPrice: BigNumber; // Units: wei/gas
};

export function randomAddress() {
  return ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
}
