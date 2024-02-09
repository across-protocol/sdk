import { BigNumber } from "ethers";
import { isDefined } from "./TypeGuards";

/**
 * This function converts a JSON string into a JSON object. The caveat is that if
 * the parser detects a number, it will convert it to a string and floor it to
 * an integer. This function will not throw but instead return an undefined value
 * if the JSON string is invalid.
 * @param jsonString The JSON string to parse
 * @returns The parsed JSON object or undefined if the JSON string is invalid
 */
export function parseJSONWithNumericString(jsonString: string): unknown | undefined {
  try {
    return JSON.parse(jsonString, (_key, value) => {
      if (typeof value === "number") {
        return String(Math.floor(value));
      }
      return value;
    });
  } catch (e) {
    return undefined;
  }
}

/**
 * This function converts an object into a JSON string. The caveat is that if
 * the parser detects a BigNumber or BN, it will convert it to a string.
 * @param obj The object to stringify
 * @returns The stringified JSON object
 * @throws Error if the object cannot be stringified
 */
export function stringifyJSONWithNumericString(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null && value.type === "BigNumber") {
      return BigNumber.from(value).toString();
    }
    return value;
  });
}

/**
 * A replacer for use in `JSON.stringify` that converts big numbers to numeric strings.
 * @param _key Unused
 * @param value The value to convert
 * @returns The converted value
 */
export function jsonReplacerWithBigNumbers(_key: string, value: unknown): unknown {
  // We need to check if this is a big number, because the JSON parser
  // is not aware of BigNumbers and will convert them to the string representation
  // of the object itself which is not what we want.
  if (BigNumber.isBigNumber(value)) {
    return value.toString();
  }
  // There's a legacy issues that returns BigNumbers as { type: "BigNumber", hex: "0x..." }
  // so we need to check for that as well.
  const recordValue = value as { type: string; hex: string };
  if (recordValue.type === "BigNumber" && isDefined(recordValue.hex)) {
    return BigNumber.from(recordValue.hex).toString();
  }
  // Return the value as is
  return value;
}

/**
 * A reviver for use in `JSON.parse` that converts numeric strings to big numbers.
 * @param _key Unused
 * @param value The value to convert
 * @returns The converted value
 */
export function jsonReviverWithBigNumbers(_key: string, value: unknown): unknown {
  // We need to check for both strings and big numbers, because the JSON parser
  // is not aware of BigNumbers.
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const bigNumber = BigNumber.from(value);
    if (bigNumber.toString() === value) {
      return bigNumber;
    }
  }
  return value;
}
