import { ethers, BigNumber } from "ethers";
import { createFormatFunction } from "@uma/common";

export { createFormatFunction };

export type BigNumberish = ethers.BigNumberish;
export type BN = ethers.BigNumber;

/**
 * Parse a stringified number into a BigNumber.
 * @param num The number to parse.
 * @returns The parsed BigNumber.
 */
export function toWei(num: BigNumberish): BN {
  return ethers.utils.parseEther(num.toString());
}

/**
 * Parse a stringified number into a BigNumber with 9 decimal places.
 * @param num The number to parse.
 * @returns The parsed BigNumber.
 */
export function toGWei(num: BigNumberish): BN {
  return ethers.utils.parseUnits(num.toString(), 9);
}

/**
 * Converts a stringified number into a BigNumber. If the string version of the num contains a `.` then it is a number which needs to be parsed to a string int.
 * @param num The number to parse.
 * @param rounding The rounding method to use if the number has a decimal point. Defaults to "floor" or rounding down. Valid values are "floor", "round", and "ceil
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

export const formatFeePct = (relayerFeePct: BigNumber): string => {
  // 1e18 = 100% so 1e16 = 1%.
  return createFormatFunction(2, 4, false, 16)(toBN(relayerFeePct).toString());
};

/**
 * Shortens a lengthy hexadecimal string to a shorter version with an ellipsis in the middle.
 * @param hex A hexadecimal string to be shortened.
 * @param maxLength The maximum length of the shortened string. Defaults to 8.
 * @param delimiter The delimiter to use in the middle of the shortened string. Defaults to "...".
 * @returns The shortened hexadecimal string.
 * @example createShortHexString("0x772871a444c6e4e9903d8533a5a13101b74037158123e6709470f0afbf6e7d94") -> "0x7787...7d94"
 */
export function createShortHexString(hex: string, maxLength = 8, delimiter = ".."): string {
  // If we have more maxLength then the hex size, we can simply
  // return the hex directly.
  if (hex.length <= maxLength) {
    return hex;
  }
  // Resolve the maximum available after we account for the delimiter.
  const maxAvailable = maxLength - delimiter.length;
  // Sanity check to make sure we have enough characters to
  // create a shortened version.
  if (maxAvailable <= 0) {
    throw new Error("Invalid max length");
  }
  // We can simulate rounding by adding 0.5 to the integer. If
  // we had an odd division, the floor will add one additional
  // character to the left side.
  const leftCharacters = Math.floor(maxAvailable / 2 + 0.5);
  // A simple floor division between the max character length
  const rightCharacters = Math.floor(maxAvailable / 2);
  // Combine the two sides with the delimiter in the middle.
  return `${hex.substring(0, leftCharacters)}${delimiter}${hex.substring(hex.length - rightCharacters)}`;
}

/**
 * Converts a utf8 string to a hex string.
 * @param input The utf8 string to convert.
 * @returns The hex string.
 */
export function utf8ToHex(input: string): string {
  return ethers.utils.formatBytes32String(input);
}

/**
 * Converts a hexadecimal string to a utf8 string.
 * @param input The hexadecimal string to convert.
 * @returns The utf8 string.
 */
export function hexToUtf8(input: string): string {
  return ethers.utils.toUtf8String(input);
}

/**
 * Converts a BigNumber to a 32-byte hexadecimal string.
 *
 * @param input - The BigNumber to convert.
 * @returns The 32-byte hexadecimal string representation of the input.
 */
export function bnToHex(input: BigNumber): string {
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(toBN(input)), 32);
}

/**
 * Converts a value from wei to a decimal value with the specified number of decimal places.
 * @param weiVal - The value in wei to convert.
 * @param decimals - The number of decimal places to include in the converted value.
 * @returns The converted value as a string.
 */
export function convertFromWei(weiVal: string, decimals: number): string {
  const formatFunction = createFormatFunction(2, 4, false, decimals);
  return formatFunction(weiVal);
}

/**
 * Shortens a list of addresses to a shorter version with only the first 10 characters.
 * @param addresses A list of addresses to shorten.
 * @returns A list of shortened addresses.
 * @see createShortHexString
 */
export function shortenHexStrings(addresses: string[]): string[] {
  return addresses.map((h) => createShortHexString(h));
}
