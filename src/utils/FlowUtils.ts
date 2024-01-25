import assert from "assert";
import { HubPoolClient } from "../clients/HubPoolClient";
import { Deposit, Fill, FillWithBlock, UbaFlow, isUbaInflow, outflowIsFill } from "../interfaces";

export const FILL_DEPOSIT_COMPARISON_KEYS = [
  "amount",
  "originChainId",
  "relayerFeePct",
  "realizedLpFeePct",
  "depositId",
  "depositor",
  "recipient",
  "destinationChainId",
  "destinationToken",
  "message",
] as const;

export function getTokenSymbolForFlow(
  flow: UbaFlow,
  chainId: number,
  hubPoolClient: HubPoolClient
): string | undefined {
  let tokenSymbol: string | undefined;
  if (isUbaInflow(flow)) {
    if (chainId !== flow.originChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.originChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(flow.originChainId, flow.originToken)?.symbol;
  } else {
    assert(outflowIsFill(flow));
    if (chainId !== flow.destinationChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.destinationChainId} fill for chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.destinationChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(flow.destinationChainId, (flow as FillWithBlock).destinationToken)?.symbol;
  }

  return tokenSymbol;
}

export function filledSameDeposit(fillA: Fill, fillB: Fill): boolean {
  return (
    fillA.depositId === fillB.depositId &&
    fillA.originChainId === fillB.originChainId &&
    fillA.amount.eq(fillB.amount) &&
    fillA.destinationChainId === fillB.destinationChainId &&
    fillA.relayerFeePct.eq(fillB.relayerFeePct) &&
    fillA.recipient === fillB.recipient &&
    fillA.depositor === fillB.depositor
  );
}

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
export function validateFillForDeposit(fill: Fill, deposit?: Deposit, fillFieldsToIgnore: string[] = []): boolean {
  if (deposit === undefined) {
    return false;
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  return FILL_DEPOSIT_COMPARISON_KEYS.every((key) => {
    if (fillFieldsToIgnore.includes(key)) {
      return true;
    }
    return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
  });
}
