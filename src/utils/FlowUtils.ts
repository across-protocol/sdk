import { Deposit, Fill, RelayData, SlowFillRequest, V2RelayData, V3Fill } from "../interfaces";
import { getV2RelayHash, getV3RelayHash } from "./SpokeUtils";
import { isV2Deposit, isV2RelayData, isV3Deposit, isV2Fill, isV3Fill } from "./V3Utils";

export const FILL_DEPOSIT_COMPARISON_KEYS = [
  "depositId",
  "originChainId",
  "destinationChainId",
  "depositor",
  "recipient",
  "message",
] as const;

export const V2_DEPOSIT_COMPARISON_KEYS = [
  ...FILL_DEPOSIT_COMPARISON_KEYS,
  "amount",
  "destinationToken",
  "relayerFeePct",
  "realizedLpFeePct",
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

  if (isV2Fill(fillA) && isV2Fill(fillB)) {
    return getV2RelayHash(fillA) === getV2RelayHash(fillB);
  } else if (isV3Fill(fillA) && isV3Fill(fillB)) {
    const { destinationChainId: chainA } = fillA;
    const { destinationChainId: chainB } = fillB;
    return getV3RelayHash(fillA, chainA) === getV3RelayHash(fillB, chainB);
  }

  return false;
}

export function validateFillForDeposit(
  relayData: RelayData & { destinationChainId: number }, // V2Deposit, V3Fill, SlowFillRequest...
  deposit?: Deposit,
  fillFieldsToIgnore: string[] = []
): boolean {
  if (deposit === undefined) {
    return false;
  }

  return isV2RelayData(relayData)
    ? validateV2FillForDeposit(relayData, deposit, fillFieldsToIgnore)
    : validateV3FillForDeposit(relayData, deposit);
}

function validateV2FillForDeposit(fill: V2RelayData, deposit: Deposit, fillFieldsToIgnore: string[] = []): boolean {
  if (!isV2Deposit(deposit)) {
    return false;
  }

  return V2_DEPOSIT_COMPARISON_KEYS.every((key) => {
    if (fillFieldsToIgnore.includes(key)) {
      return true;
    }
    return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
  });
}

function validateV3FillForDeposit(fill: V3Fill | SlowFillRequest, deposit: Deposit): boolean {
  if (!isV3Deposit(deposit)) {
    return false;
  }

  return getV3RelayHash(fill, fill.destinationChainId) === getV3RelayHash(deposit, deposit.destinationChainId);
}
