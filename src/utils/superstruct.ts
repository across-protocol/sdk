import { BigNumber } from "ethers";
import { define, string, number, union } from "superstruct";

// A 20-byte hex string, starting with "0x". Case-insensitive.
export const HexEvmAddress = define<string>("HexEvmAddress", (v) => {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
});

// A 32-byte hex string, starting with "0x". Case-insensitive.
export const HexString32Bytes = define<string>("HexString32Bytes", (v) => {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
});

// Event arguments that represent a uint256 can be returned from ethers as a BigNumber
// object, but can also be represented as a hex string or number in other contexts.
// This struct validates that the value is one of these types.
export const BigNumberishStruct = union([
  string(),
  number(),
  define<BigNumber>("EthersBigNumber", (v) => BigNumber.isBigNumber(v)),
]);
