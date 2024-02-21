import { BigNumber, ethers } from "ethers";
import { object, min as Min, define, optional, string, integer } from "superstruct";
import { DepositWithBlock } from "../interfaces";

const AddressValidator = define<string>("AddressValidator", (v) => ethers.utils.isAddress(String(v)));
const HexValidator = define<string>("HexValidator", (v) => ethers.utils.isHexString(String(v)));
const BigNumberValidator = define<BigNumber>("BigNumberValidator", (v) => ethers.BigNumber.isBigNumber(v));

const V2DepositSchema = object({
  depositId: Min(integer(), 0),
  depositor: AddressValidator,
  recipient: AddressValidator,
  originToken: AddressValidator,
  amount: BigNumberValidator,
  originChainId: Min(integer(), 0),
  destinationChainId: Min(integer(), 0),
  relayerFeePct: BigNumberValidator,
  quoteTimestamp: Min(integer(), 0),
  realizedLpFeePct: optional(BigNumberValidator),
  destinationToken: AddressValidator,
  message: string(),
  speedUpSignature: optional(string()),
  newRelayerFeePct: optional(BigNumberValidator),
  updatedRecipient: optional(string()),
  updatedMessage: optional(string()),
  blockNumber: Min(integer(), 0),
  transactionIndex: Min(integer(), 0),
  logIndex: Min(integer(), 0),
  quoteBlockNumber: Min(integer(), 0),
  transactionHash: HexValidator,
});

const V3DepositSchema = object({
  depositId: Min(integer(), 0),
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
  updatedRecipient: optional(string()),
  updatedMessage: optional(string()),
  blockNumber: Min(integer(), 0),
  transactionIndex: Min(integer(), 0),
  logIndex: Min(integer(), 0),
  quoteBlockNumber: Min(integer(), 0),
  transactionHash: HexValidator,
});

export function isDepositFormedCorrectly(deposit: unknown): deposit is DepositWithBlock {
  return V2DepositSchema.is(deposit) || V3DepositSchema.is(deposit);
}
