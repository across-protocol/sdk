import { utils as ethersUtils } from "ethers";
import { object, min as Min, define, optional, string, integer, boolean, union, number } from "superstruct";
import { DepositWithBlock } from "../interfaces";
import { BigNumber } from "../utils";

export const AddressValidator = define<string>("AddressValidator", (v) => ethersUtils.isAddress(String(v)));

export const HexString32Bytes = define<string>(
  "HexString32Bytes",
  (v) => typeof v === "string" && ethersUtils.isHexString(v, 32)
);

const HexValidator = define<string>("HexValidator", (v) => ethersUtils.isHexString(String(v)));

export const BigNumberValidator = define<BigNumber>("BigNumberValidator", (v) => BigNumber.isBigNumber(v));

// Event arguments that represent a uint256 can be returned from ethers as a BigNumber
// object, but can also be represented as a hex string or number in other contexts.
// This struct validates that the value is one of these types.
export const BigNumberishStruct = union([string(), number(), BigNumberValidator]);

// A 20-byte hex string, starting with "0x". Case-insensitive.
// Alias to AddressValidator for better validation.
export const HexEvmAddress = AddressValidator;

const V3DepositSchema = object({
  depositId: BigNumberValidator,
  depositor: AddressValidator,
  recipient: AddressValidator,
  inputToken: AddressValidator,
  inputAmount: BigNumberValidator,
  originChainId: Min(integer(), 0),
  destinationChainId: Min(integer(), 0),
  quoteTimestamp: Min(integer(), 0),
  fillDeadline: Min(integer(), 0),
  exclusivityDeadline: Min(integer(), 0),
  exclusiveRelayer: AddressValidator,
  realizedLpFeePct: optional(BigNumberValidator),
  outputToken: AddressValidator,
  outputAmount: BigNumberValidator,
  message: string(),
  speedUpSignature: optional(HexValidator),
  updatedOutputAmount: optional(BigNumberValidator),
  updatedRecipient: optional(AddressValidator),
  updatedMessage: optional(string()),
  blockNumber: Min(integer(), 0),
  transactionIndex: Min(integer(), 0),
  logIndex: Min(integer(), 0),
  quoteBlockNumber: Min(integer(), 0),
  transactionHash: HexString32Bytes,
  fromLiteChain: optional(boolean()),
  toLiteChain: optional(boolean()),
});

export function isDepositFormedCorrectly(deposit: unknown): deposit is DepositWithBlock {
  return V3DepositSchema.is(deposit);
}
