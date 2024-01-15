import { L2Provider } from "@eth-optimism/sdk/dist/interfaces/l2-provider";
import { isL2Provider as isOptimismL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import assert from "assert";
import Decimal from "decimal.js";
import { BigNumber, ethers, PopulatedTransaction, providers, VoidSigner } from "ethers";
import { getGasPriceEstimate } from "../gasPriceOracle";
import { Deposit } from "../interfaces";
import { TypedMessage } from "../interfaces/TypedData";
import { SpokePool } from "../typechain";
import { BigNumberish, BN, bnUint256Max, toBN } from "./BigNumberUtils";
import { isV2Deposit } from "./V3Utils";
import { ConvertDecimals } from "./FormattingUtils";
import { isDefined } from "./TypeGuards";
import { chainIsOPStack } from "./NetworkUtils";

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
};

/**
 * Estimates the total gas cost required to submit an unsigned (populated) transaction on-chain.
 * @param unsignedTx The unsigned transaction that this function will estimate.
 * @param senderAddress The address that the transaction will be submitted from.
 * @param provider A valid ethers provider - will be used to reason the gas price.
 * @param gasMarkup Markup on the estimated gas cost. For example, 0.2 will increase this resulting value 1.2x.
 * @param gasPrice A manually provided gas price - if set, this function will not resolve the current gas price.
 * @returns Estimated cost in units of gas and the underlying gas token (gasPrice * estimatedGasUnits).
 */
export async function estimateTotalGasRequiredByUnsignedTransaction(
  unsignedTx: PopulatedTransaction,
  senderAddress: string,
  provider: providers.Provider | L2Provider<providers.Provider>,
  gasMarkup: number,
  gasPrice?: BigNumberish
): Promise<TransactionCostEstimate> {
  assert(
    gasMarkup > -1 && gasMarkup <= 4,
    `Require -1.0 < Gas Markup (${gasMarkup}) <= 4.0 for a total gas multiplier within (0, +5.0]`
  );
  const gasTotalMultiplier = toBNWei(1.0 + gasMarkup);
  const { chainId } = await provider.getNetwork();
  const voidSigner = new VoidSigner(senderAddress, provider);

  // Estimate the Gas units required to submit this transaction.
  let nativeGasCost = await voidSigner.estimateGas(unsignedTx);
  let tokenGasCost: BigNumber;

  // OP stack is a special case; gas cost is computed by the SDK, without having to query price.
  if (chainIsOPStack(chainId)) {
    assert(isOptimismL2Provider(provider), `Unexpected provider for chain ID ${chainId}.`);
    assert(gasPrice === undefined, `Gas price (${gasPrice}) supplied for Optimism gas estimation (unused).`);
    const populatedTransaction = await voidSigner.populateTransaction(unsignedTx);
    tokenGasCost = await provider.estimateTotalGasCost(populatedTransaction);
  } else {
    if (!gasPrice) {
      const gasPriceEstimate = await getGasPriceEstimate(provider);
      gasPrice = gasPriceEstimate.maxFeePerGas;
    }
    tokenGasCost = nativeGasCost.mul(gasPrice);
  }

  // Scale the results by the computed multiplier.
  nativeGasCost = nativeGasCost.mul(gasTotalMultiplier).div(fixedPointAdjustment);
  tokenGasCost = tokenGasCost.mul(gasTotalMultiplier).div(fixedPointAdjustment);

  return {
    nativeGasCost, // Units: gas
    tokenGasCost, // Units: wei (nativeGasCost * wei/gas)
  };
}

/**
 * Create an unsigned transaction to fill a relay. This function is used to simulate the gas cost of filling a relay.
 * @param spokePool A valid SpokePool contract instance
 * @param fillToSimulate The fill that this function will use to populate the unsigned transaction
 * @returns An unsigned transaction that can be used to simulate the gas cost of filling a relay
 */
export function createUnsignedFillRelayTransactionFromDeposit(
  spokePool: SpokePool,
  deposit: Deposit,
  amountToFill: BN,
  relayerAddress: string
): Promise<PopulatedTransaction> {
  assert(isV2Deposit(deposit));

  // We need to assume certain fields exist
  const realizedLpFeePct = deposit.realizedLpFeePct;
  assert(isDefined(realizedLpFeePct));

  // If we have made it this far, then we can populate the transaction.
  if (isDefined(deposit.speedUpSignature)) {
    // If the deposit has a speed up signature, then we need to verify that certain
    // fields are present.

    const updatedRecipient = deposit.updatedRecipient;
    const updatedMessage = deposit.updatedMessage;
    const updatedRelayerFeePct = deposit.newRelayerFeePct;
    assert(isDefined(updatedRecipient) && isDefined(updatedMessage) && isDefined(updatedRelayerFeePct));

    return spokePool.populateTransaction.fillRelayWithUpdatedDeposit(
      deposit.depositor,
      deposit.recipient,
      updatedRecipient,
      deposit.destinationToken,
      deposit.amount,
      amountToFill,
      deposit.destinationChainId,
      deposit.originChainId,
      realizedLpFeePct,
      deposit.relayerFeePct,
      updatedRelayerFeePct,
      deposit.depositId,
      deposit.message,
      updatedMessage,
      deposit.speedUpSignature,
      bnUint256Max,
      {
        from: relayerAddress,
      }
    );
  } else {
    return spokePool.populateTransaction.fillRelay(
      deposit.depositor,
      deposit.recipient,
      deposit.destinationToken,
      deposit.amount,
      amountToFill,
      deposit.destinationChainId, // Assume we're refunding to destination
      deposit.originChainId,
      realizedLpFeePct,
      deposit.relayerFeePct,
      deposit.depositId,
      deposit.message,
      bnUint256Max,
      {
        from: relayerAddress,
      }
    );
  }
}

export type UpdateDepositDetailsMessageType = {
  UpdateDepositDetails: [
    {
      name: "depositId";
      type: "uint32";
    },
    { name: "originChainId"; type: "uint256" },
    { name: "updatedRelayerFeePct"; type: "int64" },
    { name: "updatedRecipient"; type: "address" },
    { name: "updatedMessage"; type: "bytes" },
  ];
};

export type UpdateV3DepositDetailsMessageType = {
  UpdateDepositDetails: [
    { name: "depositId"; type: "uint32" },
    { name: "originChainId"; type: "uint256" },
    { name: "updatedOutputAmount"; type: "uint256" },
    { name: "updatedRecipient"; type: "address" },
    { name: "updatedMessage"; type: "bytes" },
  ];
};

/**
 * Utility function to get EIP-712 compliant typed data that can be signed with the JSON-RPC method
 * `eth_signedTypedDataV4` in MetaMask (https://docs.metamask.io/guide/signing-data.html). The resulting signature
 * can then be used to call the method `speedUpDeposit` of a `SpokePool.sol` contract.
 * @param depositId The deposit ID to speed up.
 * @param originChainId The chain ID of the origin chain.
 * @param updatedRelayerFeePct The new relayer fee percentage.
 * @param updatedRecipient The new recipient address.
 * @param updatedMessage The new message that should be provided to the recipient.
 * @return EIP-712 compliant typed data.
 */
export function getUpdateDepositTypedData(
  depositId: number,
  originChainId: number,
  updatedRelayerFeePct: BigNumber,
  updatedRecipient: string,
  updatedMessage: string
): TypedMessage<UpdateDepositDetailsMessageType> {
  return {
    types: {
      UpdateDepositDetails: [
        { name: "depositId", type: "uint32" },
        { name: "originChainId", type: "uint256" },
        { name: "updatedRelayerFeePct", type: "int64" },
        { name: "updatedRecipient", type: "address" },
        { name: "updatedMessage", type: "bytes" },
      ],
    },
    primaryType: "UpdateDepositDetails",
    domain: {
      name: "ACROSS-V2",
      version: "1.0.0",
      chainId: originChainId,
    },
    message: {
      depositId,
      originChainId,
      updatedRelayerFeePct,
      updatedRecipient,
      updatedMessage,
    },
  };
}

export function getUpdateV3DepositTypedData(
  depositId: number,
  originChainId: number,
  updatedOutputAmount: BigNumber,
  updatedRecipient: string,
  updatedMessage: string
): TypedMessage<UpdateV3DepositDetailsMessageType> {
  return {
    types: {
      UpdateDepositDetails: [
        { name: "depositId", type: "uint32" },
        { name: "originChainId", type: "uint256" },
        { name: "updatedOutputAmount", type: "uint256" },
        { name: "updatedRecipient", type: "address" },
        { name: "updatedMessage", type: "bytes" },
      ],
    },
    primaryType: "UpdateDepositDetails",
    domain: {
      name: "ACROSS-V2",
      version: "1.0.0",
      chainId: originChainId,
    },
    message: {
      depositId,
      originChainId,
      updatedOutputAmount,
      updatedRecipient,
      updatedMessage,
    },
  };
}

export function randomAddress() {
  return ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
}
