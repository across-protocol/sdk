import { BigNumber, ethers, PopulatedTransaction, providers, VoidSigner } from "ethers";
import * as uma from "@uma/sdk";
import Decimal from "decimal.js";
import { isL2Provider as isOptimismL2Provider, L2Provider } from "@eth-optimism/sdk";
import { SpokePool } from "@across-protocol/contracts-v2";
import assert from "assert";

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
  return new Decimal(endAmount).sub(startAmount).div(startAmount).mul(periodsPerYear).div(periodsElapsed).toString();
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
  let promiseChain = call();
  for (let i = 0; i < times; i++)
    promiseChain = promiseChain.catch(async () => {
      await delay(delayS);
      return await call();
    });
  return promiseChain;
}

/**
 * Estimates the total gas cost required to submit an unsigned (populated) transaction on-chain
 * @param unsignedTx The unsigned transaction that this function will estimate
 * @param senderAddress The address that the transaction will be submitted from
 * @param provider A valid ethers provider - will be used to reason the gas price
 * @param gasMarkup Represents a percent increase on the total gas cost. For example, 0.2 will increase this resulting value by a factor of 1.2
 * @param gasPrice A manually provided gas price - if set, this function will not resolve the current gas price
 * @returns The total gas cost to submit this transaction - i.e. gasPrice * estimatedGasUnits
 */
export async function estimateTotalGasRequiredByUnsignedTransaction(
  unsignedTx: PopulatedTransaction,
  senderAddress: string,
  provider: providers.Provider | L2Provider<providers.Provider>,
  gasMarkup: number,
  gasPrice?: BigNumberish
): Promise<BigNumberish> {
  assert(gasMarkup > -1 && gasMarkup <= 4, "Gas Markup must be within the range of (-1.0, +4.0] so that total gas multiplier is between (0, +5.0]");
  const gasTotalMultiplier = 1.0 + gasMarkup;
  const voidSigner = new VoidSigner(senderAddress, provider);
  // Verify if this provider has been L2Provider wrapped
  // NOTE: In this case, this will be true if the provider is
  //       using the Optimism blockchain
  if (isOptimismL2Provider(provider)) {
    const populatedTransaction = await voidSigner.populateTransaction(unsignedTx);
    return (await provider.estimateTotalGasCost(populatedTransaction)).mul(gasTotalMultiplier).toString();
  } else {
    // Estimate the Gas units required to submit this transaction
    const estimatedGasUnits = await voidSigner.estimateGas(unsignedTx);
    // Provide a default gas price of the market rate if this condition has not been set
    const resolvedGasPrice = gasPrice ?? (await provider.getGasPrice());
    // Find the total gas cost by taking the product of the gas
    // price & the estimated number of gas units needed
    return BigNumber.from(resolvedGasPrice).mul(gasTotalMultiplier).mul(estimatedGasUnits).toString();
  }
}

/**
 * Create an unsigned transaction of a fillRelay contract call
 * @param spokePool The specific spokepool that will populate this tx
 * @param destinationTokenAddress A valid ERC20 token (system-wide default is UDSC)
 * @param simulatedRelayerAddress The relayer address that relays this transaction
 * @returns A populated (but unsigned) transaction that can be signed/sent or used for estimating gas costs
 */
export async function createUnsignedFillRelayTransaction(
  spokePool: SpokePool,
  destinationTokenAddress: string,
  simulatedRelayerAddress: string
): Promise<PopulatedTransaction> {
  // Populate and return an unsigned tx as per the given spoke pool
  // NOTE: 0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B is a dummy address
  return await spokePool.populateTransaction.fillRelay(
    "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
    "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
    destinationTokenAddress,
    "10",
    "10",
    "1",
    "1",
    "1",
    "1",
    "1",
    { from: simulatedRelayerAddress }
  );
}
