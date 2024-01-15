import assert from "assert";
import { HubPoolClient } from "../clients/HubPoolClient";
import { Deposit, Fill, UbaFlow, isUbaInflow, outflowIsFill } from "../interfaces";
import { BN } from "../utils";
import { getDepositInputAmount, getFillOutputAmount, isV2Deposit, isV3Deposit, isV2Fill, isV3Fill } from "./V3Utils";

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

export function getFlowAmount(flow: UbaFlow): BN {
  if (isUbaInflow(flow)) {
    return getDepositInputAmount(flow);
  }

  assert(outflowIsFill(flow));
  // We currently assume UBA fills have undefined realizedLpFeePct, but this is
  // also true of v3 fills. Defer support until v2 deposits are deprecated.
  assert(isV2Fill(flow));
  return getFillOutputAmount(flow);
}

export function getFlowToken(flow: UbaFlow): string {
  if (isUbaInflow(flow)) {
    return isV2Deposit(flow) ? flow.originToken : flow.inputToken;
  }

  assert(outflowIsFill(flow));
  assert(isV2Fill(flow));
  return flow.destinationToken;
}

export function getTokenSymbolForFlow(
  flow: UbaFlow,
  chainId: number,
  hubPoolClient: HubPoolClient
): string | undefined {
  let tokenSymbol: string | undefined;
  const flowToken = getFlowToken(flow);
  if (isUbaInflow(flow)) {
    if (chainId !== flow.originChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.originChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(flow.originChainId, flowToken)?.symbol;
  } else {
    assert(outflowIsFill(flow));
    if (chainId !== flow.destinationChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.destinationChainId} fill for chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.destinationChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(flow.destinationChainId, flowToken)?.symbol;
  }

  return tokenSymbol;
}

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
