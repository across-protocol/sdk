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
    // Resolve a rounding function from the rounding parameter.
    const roundingFunction = Math[rounding];
    // Parse the number to a string float and round it.
    return BigNumber.from(roundingFunction(parseFloat(num.toString())));
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
 * @returns The shortened hexadecimal string.
 * @example shortenHexString("0x772871a444c6e4e9903d8533a5a13101b74037158123e6709470f0afbf6e7d94") -> "0x7787...7d94"
 */
export function createShortHexString(hex: string): string {
  return hex.substring(0, 5) + "..." + hex.substring(hex.length - 6, hex.length);
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
 * @see shortenHexString
 */
export function shortenHexStrings(addresses: string[]): string[] {
  return addresses.map((address) => shortenHexString(address));
}

/**
 * Shortens a hexadecimal string to a shorter version with only the first 10 characters.
 * @param hexString A hexadecimal string to shorten.
 * @returns The shortened hexadecimal string.
 */
export function shortenHexString(hexString: string): string {
  return hexString.substring(0, 10);
}
