import { isDefined } from "../utils";
import { Deposit, RelayData } from "../interfaces";
import { UNDEFINED_MESSAGE_HASH } from "../constants";

export const RELAYDATA_KEYS = [
  "depositId",
  "originChainId",
  "destinationChainId",
  "depositor",
  "recipient",
  "inputToken",
  "inputAmount",
  "outputToken",
  "outputAmount",
  "fillDeadline",
  "exclusivityDeadline",
  "exclusiveRelayer",
  "messageHash",
] as const;

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as destinationToken, which are pulled from other clients.
export function validateFillForDeposit(
  relayData: Omit<RelayData, "message"> & { messageHash: string; destinationChainId: number },
  deposit?: Omit<Deposit, "quoteTimestamp" | "fromLiteChain" | "toLiteChain">
): { valid: true } | { valid: false; reason: string } {
  if (deposit === undefined) {
    return { valid: false, reason: "Deposit is undefined" };
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  let invalidKey = RELAYDATA_KEYS.find((key) => relayData[key].toString() !== deposit[key].toString());

  // There should be no paths for `messageHash` to be unset, but mask it off anyway.
  // @todo Add test.
  if (!isDefined(invalidKey) && [relayData.messageHash, deposit.messageHash].includes(UNDEFINED_MESSAGE_HASH)) {
    invalidKey = "messageHash";
  }

  return isDefined(invalidKey)
    ? { valid: false, reason: `${invalidKey} mismatch (${relayData[invalidKey]} != ${deposit[invalidKey]})` }
    : { valid: true };
}
