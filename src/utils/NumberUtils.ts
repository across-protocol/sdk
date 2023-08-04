/**
 * A typeguard for a number with the added check that the number is an integer.
 * @param value The value to check.
 * @returns True if the value is a number and an integer, false otherwise.
 */
export function isInteger(value: unknown): value is number {
  return !Number.isNaN(Number(value)) && Number.isInteger(value);
}
