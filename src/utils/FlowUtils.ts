import { isDefined, isMessageEmpty } from "../utils";
import { ZERO_BYTES } from "../constants";
import { Deposit, RelayData } from "../interfaces";
import { utils } from "ethers";

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
] as const;

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as destinationToken, which are pulled from other clients.
export function validateFillForDeposit(
  relayData: RelayData & { destinationChainId: number; messageHash?: string },
  deposit?: Deposit
): { valid: true } | { valid: false; reason: string } {
  if (deposit === undefined) {
    return { valid: false, reason: "Deposit is undefined" };
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  const invalidKey = RELAYDATA_KEYS.find((key) => relayData[key].toString() !== deposit[key].toString());

  const calculateMessageHash = (message: string) => {
    return isMessageEmpty(message) ? ZERO_BYTES : utils.keccak256(deposit.message);
  };
  // Manually check if the message hash does not match.
  // This is done separately since the deposit event emits the full message, while the relay event only emits the message hash.
  const messageHash = calculateMessageHash(deposit.message);
  // We may be checking a FilledV3Relay event or a FilledRelay event here. If we are checking a FilledV3Relay event, then relayData.message will be defined,
  // and relayData.messageHash will be undefined. If we are checking a FilledRelay event, the opposite will be true.
  const relayHash = isDefined(relayData.message) ? calculateMessageHash(relayData.message) : relayData.messageHash;
  if (messageHash !== relayHash) {
    return { valid: false, reason: `message mismatch (${messageHash} != ${relayHash})` };
  }

  return isDefined(invalidKey)
    ? { valid: false, reason: `${invalidKey} mismatch (${relayData[invalidKey]} != ${deposit[invalidKey]})` }
    : { valid: true };
}
