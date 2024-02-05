import { Deposit, Fill } from "../interfaces";
import { isV2Deposit, isV3Deposit, isV2Fill, isV3Fill } from "./V3Utils";

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
] as const;

export function filledSameDeposit(fillA: Fill, fillB: Fill): boolean {
  if (isV2Fill(fillA) && isV2Fill(fillB)) {
    return (
      fillA.depositId === fillB.depositId &&
      fillA.originChainId === fillB.originChainId &&
      fillA.amount.eq(fillB.amount) &&
      fillA.destinationChainId === fillB.destinationChainId &&
      fillA.relayerFeePct.eq(fillB.relayerFeePct) &&
      fillA.recipient === fillB.recipient &&
      fillA.depositor === fillB.depositor &&
      fillA.message === fillB.message
    );
  } else if (isV3Fill(fillA) && isV3Fill(fillB)) {
    return (
      fillA.depositId === fillB.depositId &&
      fillA.originChainId === fillB.originChainId &&
      fillA.destinationChainId === fillB.destinationChainId &&
      fillA.recipient === fillB.recipient &&
      fillA.depositor === fillB.depositor &&
      fillA.inputToken === fillB.inputToken &&
      fillA.outputToken === fillB.outputToken &&
      fillA.message === fillB.message &&
      fillA.inputAmount.eq(fillB.inputAmount) &&
      fillA.outputAmount.eq(fillB.outputAmount)
    );
  }

  return false;
}

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
export function validateFillForDeposit(fill: Fill, deposit?: Deposit, fillFieldsToIgnore: string[] = []): boolean {
  if (deposit === undefined) {
    return false;
  }

  if (isV2Deposit(deposit) && isV2Fill(fill)) {
    return V2_DEPOSIT_COMPARISON_KEYS.every((key) => {
      if (fillFieldsToIgnore.includes(key)) {
        return true;
      }
      return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
    });
  }

  if (isV3Deposit(deposit) && isV3Fill(fill)) {
    return V3_DEPOSIT_COMPARISON_KEYS.every((key) => {
      if (fillFieldsToIgnore.includes(key)) {
        return true;
      }
      return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
    });
  }

  return false;
}
