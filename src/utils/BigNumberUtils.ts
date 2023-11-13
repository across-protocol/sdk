/**
 * @file Responsible for providing utility functions for working with BigNumbers.
 * @module utils/BigNumberUtils
 * @author Across Protocol
 */

import { ethers, BigNumber } from "ethers";

export type BigNumberish = ethers.BigNumberish;
export type BN = ethers.BigNumber;

export const { Zero: bnZero, One: bnOne, MaxUint256: bnUint256Max } = ethers.constants;

export const bnUint32Max = BigNumber.from("0xffffffff");

/**
 * Converts a stringified number into a BigNumber with 18 decimal places.
 * @param num The number to parse.
 * @returns The parsed BigNumber.
 */
export function toWei(num: BigNumberish): BN {
  return ethers.utils.parseEther(num.toString());
}

/**
 * Converts a stringified number into a BigNumber with 9 decimal places.
 * @param num The number to parse.
 * @returns The parsed BigNumber.
 */
export function toGWei(num: BigNumberish): BN {
  return ethers.utils.parseUnits(num.toString(), 9);
}

/**
 * Converts a stringified number into a BigNumber.
 * If the string version of the num contains a `.` then it is a number which needs to be parsed to a string int.
 * @param num The number to parse.
 * @param rounding The rounding method to use if the number has a decimal point. Defaults to "floor" or rounding down. Valid values are "floor", "round", and "ceil".
 * @returns The parsed BigNumber.
 * @note This is a temporary function until we can backport support for decimal points to @across-protocol/sdk-v2.
 */
export const toBN = (num: BigNumberish, rounding: "floor" | "round" | "ceil" = "floor"): BN => {
  // If the string version of the num contains a `.` then it is a number which needs to be parsed to a string int.
  if (num.toString().includes(".")) {
    // Destructure the integer and decimal parts of the number.
    const [integer, decimal] = num.toString().split(".");
    // We can determine if we need to round in a losseless way. First we need to check
    // if the number just has a decimal point with no decimal places. If it does, we
    // can just return the integer. However, if it has a decimal point with decimal
    // places, then we can automatically round up if ceil is specified or if round is
    // specified and the first decimal is greater than or equal to 5.
    const roundUp = decimal.length > 0 && (rounding === "ceil" || (rounding === "round" && parseInt(decimal[0]) >= 5));
    // If we need to round up, we can just add 1 to the integer.
    return BigNumber.from(integer).add(roundUp ? 1 : 0);
  }
  // Otherwise, it is a string int and we can parse it directly.
  return BigNumber.from(num.toString());
};
