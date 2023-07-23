// JSON.stringify(object) ends up stringfying BigNumber objects as "{type:BigNumber,hex...}" so we can pass
// this reviver function as the second arg to JSON.parse to instruct it to correctly revive a stringified

import { BigNumberish, toBN } from "./common";

// object with BigNumber values.
export function objectWithBigNumberReviver(_: string, value: { type: string; hex: BigNumberish }) {
  if (typeof value !== "object" || value?.type !== "BigNumber") {
    return value;
  }
  return toBN(value.hex);
}
