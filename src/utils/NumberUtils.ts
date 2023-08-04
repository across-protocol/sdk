/**
 * A typeguard for a number with the added check that the number is an integer.
 * @param value The value to check.
 * @returns True if the value is a number and an integer, false otherwise.
 */
export function isInteger(value: unknown): value is number {
  return !Number.isNaN(Number(value)) && Number.isInteger(value);
}

/**
 * A typeguard for a number with added checks that the number is an integer and is greater to zero.
 * @param value The value to check.
 * @returns True if the value is a number, an integer, and greater than zero, false otherwise.
 */
export function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}
