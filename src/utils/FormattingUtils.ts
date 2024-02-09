import { ethers } from "ethers";
import { BN, toBN } from "./BigNumberUtils";
import { fromWei } from "./common";
import assert from "assert";
import { BigNumber } from "bignumber.js";

// Formats the input to round to decimalPlaces number of decimals if the number has a magnitude larger than 1 and fixes
// precision to minPrecision if the number has a magnitude less than 1.
export const formatWithMaxDecimals = (
  num: number | string,
  decimalPlaces: number,
  minPrecision: number,
  roundUp: boolean,
  showSign: boolean
): string => {
  if (roundUp) {
    BigNumber.set({ ROUNDING_MODE: BigNumber.ROUND_UP });
  } else {
    BigNumber.set({ ROUNDING_MODE: BigNumber.ROUND_DOWN });
  }

  const fullPrecisionFloat = new BigNumber(num);
  const positiveSign = showSign && fullPrecisionFloat.gt(0) ? "+" : "";
  let fixedPrecisionFloat;
  // Convert back to BN to truncate any trailing 0s that the toFixed() output would print. If the number is equal to or larger than
  // 1 then truncate to `decimalPlaces` number of decimal places. EG 999.999 -> 999.99 with decimalPlaces=2 If the number
  // is less than 1 then truncate to minPrecision precision. EG: 0.0022183471 -> 0.002218 with minPrecision=4
  if (fullPrecisionFloat.abs().gte(new BigNumber(1))) {
    fixedPrecisionFloat = new BigNumber(fullPrecisionFloat).toFixed(decimalPlaces).toString();
  } else {
    fixedPrecisionFloat = new BigNumber(fullPrecisionFloat).toPrecision(minPrecision).toString();
  }
  // This puts commas in the thousands places, but only before the decimal point.
  const fixedPrecisionFloatParts = fixedPrecisionFloat.split(".");
  fixedPrecisionFloatParts[0] = fixedPrecisionFloatParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return positiveSign + fixedPrecisionFloatParts.join(".");
};

export const createFormatFunction = (
  numDisplayedDecimals: number,
  minDisplayedPrecision: number,
  showSign = false,
  decimals = 18
) => {
  return (valInWei: string | BN): string =>
    formatWithMaxDecimals(
      formatWei(ConvertDecimals(decimals, 18)(valInWei)),
      numDisplayedDecimals,
      minDisplayedPrecision,
      false,
      showSign
    );
};
export const formatFeePct = (relayerFeePct: BN): string => {
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
export function bnToHex(input: BN): string {
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

// formatWei converts a string or BN instance from Wei to Ether, e.g., 1e19 -> 10.
export const formatWei = (num: string | BN): string => {
  // Web3's `fromWei` function doesn't work on BN objects in minified mode (e.g.,
  // `web3.utils.isBN(web3.utils.fromBN("5"))` is false), so we use a workaround where we always pass in strings.
  // See https://github.com/ethereum/web3.js/issues/1777.
  return fromWei(num.toString());
};

// Take an amount based on fromDecimals and convert it to an amount based on toDecimals. For example 100 usdt = 100e6,
// with 6 decimals. If you wanted to convert this to a base 18 decimals you would get:
// convertDecimals(6,18)(100000000)  => 100000000000000000000 = 100e18.
// Returns a BigNumber you will need to call toString on
// fromDecimals: number - decimal value of amount
// toDecimals: number - decimal value to convert to
// web3: web3 object to get a big number function.
// return => (amount:string)=>BN
export const ConvertDecimals = (fromDecimals: number, toDecimals: number): ((amountIn: string | number | BN) => BN) => {
  assert(fromDecimals >= 0, "requires fromDecimals as an integer >= 0");
  assert(toDecimals >= 0, "requires toDecimals as an integer >= 0");
  // amount: string, BN, number - integer amount in fromDecimals smallest unit that want to convert toDecimals
  // returns: BN with toDecimals in smallest unit
  return (amountIn: string | number | BN) => {
    const amount = toBN(amountIn.toString());
    if (amount.isZero()) return amount;
    const diff = fromDecimals - toDecimals;
    if (diff == 0) return amount;
    if (diff > 0) return amount.div(toBN("10").pow(toBN(diff.toString())));
    return amount.mul(toBN("10").pow(toBN((-1 * diff).toString())));
  };
};

/**
 * Converts a numeric decimal-inclusive string to winston, the base unit of Arweave
 * @param numericString The numeric string to convert
 * @returns The winston representation of the numeric string as a BigNumber
 */
export function parseWinston(numericString: string): ethers.BigNumber {
  return ethers.utils.parseUnits(numericString, 12);
}

/**
 * Converts a winston value to a numeric string
 * @param winstonValue The winston value to convert
 * @returns The numeric string representation of the winston value
 */
export function formatWinston(winstonValue: ethers.BigNumber): string {
  return ethers.utils.formatUnits(winstonValue, 12);
}
