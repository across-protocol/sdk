import { BigNumber, ethers, PopulatedTransaction, providers, VoidSigner } from "ethers";
import * as uma from "@uma/sdk";
import Decimal from "decimal.js";
import { isL2Provider as isOptimismL2Provider, L2Provider } from "@eth-optimism/sdk";
import { SpokePool } from "@across-protocol/contracts-v2";
import assert from "assert";
import { GasPriceEstimate, getGasPriceEstimate } from "./gasPriceOracle";

export type BigNumberish = string | number | BigNumber;
export type BN = BigNumber;
export type Decimalish = string | number | Decimal;
export const AddressZero = ethers.constants.AddressZero;

const { ConvertDecimals } = uma.utils;
// These are distances used to traverse when looking for a block with desired lookback.
// They're meant to be small enough to allow for granularity but large enough to minimize the number of reqests needed
// to find the desired block.
const BlockScanSkipDistances: { [chainId: number]: number } = {
  1: 1000,
  10: 100000,
  137: 10000,
  288: 1000,
  42161: 100000,
};

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
  assert(
    gasMarkup > -1 && gasMarkup <= 4,
    `Require -1.0 < Gas Markup (${gasMarkup}) <= 4.0 for a total gas multiplier within (0, +5.0]`
  );
  const gasTotalMultiplier = toBNWei(1.0 + gasMarkup);
  const network: providers.Network = await provider.getNetwork(); // Served locally by StaticJsonRpcProvider.
  const voidSigner = new VoidSigner(senderAddress, provider);

  // Optimism is a special case; gas cost is computed by the SDK, without having to query price.
  if ([10].includes(network.chainId)) {
    assert(isOptimismL2Provider(provider), `Unexpected provider for chain ID ${network.chainId}.`);
    assert(gasPrice === undefined, `Gas price (${gasPrice}) supplied for Optimism gas estimation (unused).`);
    const populatedTransaction = await voidSigner.populateTransaction(unsignedTx);
    return (await provider.estimateTotalGasCost(populatedTransaction))
      .mul(gasTotalMultiplier)
      .div(toBNWei(1))
      .toString();
  }

  if (!gasPrice) {
    const gasPriceEstimate: GasPriceEstimate = await getGasPriceEstimate(provider);
    gasPrice = gasPriceEstimate.maxFeePerGas;
  }

  // Estimate the Gas units required to submit this transaction
  const estimatedGasUnits = await voidSigner.estimateGas(unsignedTx);

  // Find the total gas cost by taking the product of the gas price & the
  // estimated number of gas units needed.
  return BigNumber.from(gasPrice).mul(gasTotalMultiplier).mul(estimatedGasUnits).div(toBNWei(1)).toString();
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

/**
 * Search back in time for the first block at or older than the desired lookback.
 *
 * The approach here is as below:
 * 1. We use the skip distances, which are meant to be a couple of hours or less for each chain.
 * 2. Fetch the first block one skip distance from the latest block. Check its timestamp to see how far back it is
 * relatively to the latest block.
 * 3. Apply a multiplier to the skip distance based on the time difference and find a block with the desired lookback
 * This assumes the block production speed is roughly constant.
 * 4. Check the timestamp again, if we still haven't achieved the desired lookback, repeat step 3 and go back further.
 * Otherwise, return the block number.
 *
 * This is only a rough estimate and can go back further than desired. However, this would minimize the number
 * of requests and is generally accurate unless the rate of block production has been very volatile over a
 * short period of time.
 *
 * @param provider A valid provider - will be used to find the block with desired lookback.
 * @param desiredLookback Desired lookback in seconds (e.g. 86400 seconds or 1 day).
 * @return The block number that's at or older than the desired lookback.
 */
export async function findBlockAtOrOlder(provider: providers.Provider, desiredLookback: number): Promise<number> {
  const [toBlock, network] = await Promise.all([provider.getBlock("latest"), provider.getNetwork()]);
  let toBlockTimestamp = toBlock.timestamp;
  const desiredTimestamp = toBlockTimestamp - desiredLookback;
  let skipDistance = BlockScanSkipDistances[network.chainId];

  // Fetch the first block to get the block production speed estimate before proceeding further.
  let fromBlockNumber = toBlock.number - skipDistance;
  let fromBlock = await provider.getBlock(fromBlockNumber);
  let fromBlockTimestamp = fromBlock.timestamp;
  while (fromBlockTimestamp > desiredTimestamp) {
    // Calculate the block speed based on last block query and use it to calculate how many more blocks to go back
    // to find the block with desired timestamp.
    const blockSpeed = skipDistance / (toBlockTimestamp - fromBlockTimestamp);
    skipDistance = Math.floor(blockSpeed * (fromBlockTimestamp - desiredTimestamp));
    fromBlockNumber -= skipDistance;
    fromBlock = await provider.getBlock(fromBlockNumber);
    // Set toBlock equal to current fromBlock and then decrement fromBlock
    toBlockTimestamp = fromBlockTimestamp;
    fromBlockTimestamp = fromBlock.timestamp;
  }
  return fromBlockNumber;
}
