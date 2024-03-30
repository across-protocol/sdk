import { Deposit, Fill, RelayData, SlowFillRequest } from "../interfaces";
import { getRelayDataHash } from "./SpokeUtils";

export const FILL_DEPOSIT_COMPARISON_KEYS = [
  "depositId",
  "originChainId",
  "destinationChainId",
  "depositor",
  "recipient",
  "message",
] as const;

export const V3_DEPOSIT_COMPARISON_KEYS = [
  ...FILL_DEPOSIT_COMPARISON_KEYS,
  "inputToken",
  "inputAmount",
  "outputToken",
  "outputAmount",
  "fillDeadline",
  "exclusivityDeadline",
  "exclusiveRelayer",
] as const;

export function filledSameDeposit(fillA: Fill, fillB: Fill): boolean {
  // Don't bother hashing obvious mismatches.
  if (fillA.depositId !== fillB.depositId) {
    return false;
  }

  const { destinationChainId: chainA } = fillA;
  const { destinationChainId: chainB } = fillB;
  return getRelayDataHash(fillA, chainA) === getRelayDataHash(fillB, chainB);
}

export function validateFillForDeposit(
  relayData: RelayData & { destinationChainId: number }, // V3Fill, SlowFillRequest...
  deposit?: Deposit
): boolean {
  if (deposit === undefined) {
    return false;
  }

  return validateV3FillForDeposit(relayData, deposit);
}

function validateV3FillForDeposit(fill: Fill | SlowFillRequest, deposit: Deposit): boolean {
  return getRelayDataHash(fill, fill.destinationChainId) === getRelayDataHash(deposit, deposit.destinationChainId);
}
