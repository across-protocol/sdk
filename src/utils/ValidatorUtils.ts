import { BigNumber, ethers } from "ethers";
import { object, min as Min, define, optional, string, integer, assign } from "superstruct";
import { DepositWithBlock, PartialDepositWithBlock } from "../interfaces";
import { isV2Deposit } from "./V3Utils";

const AddressValidator = define<string>("AddressValidator", (v) => ethers.utils.isAddress(String(v)));
const HexValidator = define<string>("HexValidator", (v) => ethers.utils.isHexString(String(v)));
const BigNumberValidator = define<BigNumber>("BigNumberValidator", (v) => ethers.BigNumber.isBigNumber(v));

const CommonEventSchema = object({
  blockNumber: Min(integer(), 0),
  transactionIndex: Min(integer(), 0),
  logIndex: Min(integer(), 0),
  transactionHash: HexValidator,
});
const CommonPartialDepositSchema = assign(
  CommonEventSchema,
  object({
    depositId: Min(integer(), 0),
    depositor: AddressValidator,
    recipient: AddressValidator,
    originChainId: Min(integer(), 0),
    destinationChainId: Min(integer(), 0),
    quoteTimestamp: Min(integer(), 0),
    message: string(),
  })
);
const V2PartialDepositSchema = assign(
  assign(CommonEventSchema, CommonPartialDepositSchema),
  object({
    originToken: AddressValidator,
    amount: BigNumberValidator,
    relayerFeePct: BigNumberValidator,
  })
);
const V3PartialDepositSchema = assign(
  assign(CommonEventSchema, CommonPartialDepositSchema),
  object({
    inputToken: AddressValidator,
    inputAmount: BigNumberValidator,
    outputToken: AddressValidator,
    outputAmount: BigNumberValidator,
    exclusivityDeadline: Min(integer(), 0),
    exclusiveRelayer: AddressValidator,
    fillDeadline: Min(integer(), 0),
  })
);
const CommonDepositSchema = object({
  realizedLpFeePct: BigNumberValidator,
  speedUpSignature: optional(string()),
  updatedRecipient: optional(string()),
  updatedMessage: optional(string()),
});
const V2DepositSchema = assign(
  assign(V2PartialDepositSchema, CommonDepositSchema),
  object({
    destinationToken: AddressValidator,
    newRelayerFeePct: optional(BigNumberValidator),
  })
);
const V3DepositSchema = assign(
  assign(V3PartialDepositSchema, CommonDepositSchema),
  object({
    updatedOutputAmount: optional(BigNumberValidator),
  })
);

export function isPartialDepositFormedCorrectly(deposit: unknown): deposit is PartialDepositWithBlock {
  if (isV2Deposit(deposit as DepositWithBlock)) return V2PartialDepositSchema.is(deposit);
  else return V3PartialDepositSchema.is(deposit);
}

export function isDepositFormedCorrectly(deposit: unknown): deposit is DepositWithBlock {
  if (isV2Deposit(deposit as DepositWithBlock)) return V2DepositSchema.is(deposit);
  else return V3DepositSchema.is(deposit);
}
