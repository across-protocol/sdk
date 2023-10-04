import { toBN } from "./BigNumberUtils";
import { isDefined } from "./TypeGuards";
import { Reviver } from "./TypeUtils";

/**
 * A reviver composer that takes a list of revivers and returns a single reviver that applies all of them.
 * @param revivers The revivers to compose.
 * @returns A single reviver that applies all of the revivers passed in. If no revivers are passed in, the identity
 * function is returned.
 */
export function composeRevivers(...revivers: Reviver[]): Reviver {
  // Filter out undefined revivers.
  revivers = revivers.filter(isDefined);
  // Return a single reviver that applies all of the revivers passed in. If no revivers are passed in, the identity
  // function is implicitly returned.
  return (key: string, value: unknown) => revivers.reduce((acc, reviver) => reviver(key, acc), value);
}

/**
 * Reviver function that converts a stringified BigNumber object to a BigNumber object.
 * @param _ The key to the value being revived. Unused.
 * @param value The value being revived.
 * @returns The revived value. If the value is not a stringified BigNumber object, it is returned as-is.
 */
export function objectWithBigNumberReviver(_: unknown, value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const resolvedValue = value as { type: string; hex: string };
  return resolvedValue.type === "BigNumber" ? toBN(resolvedValue.hex) : resolvedValue;
}
