import { BigNumber, ethers } from "ethers";
import { object, number as Number, min as Min, define, optional, string } from "superstruct";
import { Deposit } from "../interfaces";

const AddressValidator = define<string>("AddressValidator", (v) => ethers.utils.isAddress(String(v)));
const BigNumberValidator = define<BigNumber>("BigNumberValidator", (v) => ethers.BigNumber.isBigNumber(v));

const DepositSchema = object({
  depositId: Min(Number(), 0),
  depositor: AddressValidator,
  recipient: AddressValidator,
  originToken: AddressValidator,
  amount: BigNumberValidator,
  originChainId: Min(Number(), 0),
  destinationChainId: Min(Number(), 0),
  relayerFeePct: BigNumberValidator,
  quoteTimestamp: Min(Number(), 0),
  realizedLpFeePct: optional(BigNumberValidator),
  destinationToken: AddressValidator,
  message: string(),
  speedUpSignature: optional(string()),
  newRelayerFeePct: optional(BigNumberValidator),
  updatedRecipient: optional(string()),
  updatedMessage: optional(string()),
});

export function isDepositFormedCorrectly(deposit: unknown): deposit is Deposit {
  return DepositSchema.is(deposit);
}
