import { HubPoolClient, getModifiedFlow } from "../clients";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RefundRequestWithBlock,
  UbaFlow,
  UbaOutflow,
  isUbaInflow,
  outflowIsFill,
} from "../interfaces";
import { SpokePoolClients } from "./TypeUtils";

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
  } else if (outflowIsFill(flow as UbaOutflow)) {
    if (chainId !== flow.destinationChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.destinationChainId} fill for chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.destinationChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(flow.destinationChainId, (flow as FillWithBlock).destinationToken)?.symbol;
  } else if (chainId !== (flow as RefundRequestWithBlock).repaymentChainId) {
    if (chainId !== flow.repaymentChainId) {
      throw new Error(
        `ChainId mismatch on chain ${flow.repaymentChainId} for chain ${flow.originChainId} deposit ${flow.depositId} (${chainId} != ${flow.repaymentChainId})`
      );
    }
    tokenSymbol = hubPoolClient.getTokenInfo(
      flow.repaymentChainId,
      (flow as RefundRequestWithBlock).refundToken
    )?.symbol;
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
export function validateFillForDeposit(fill: Fill, deposit?: Deposit): boolean {
  if (deposit === undefined) {
    return false;
  }

  if (deposit.realizedLpFeePct === undefined) {
    throw new Error("realizedLpFeePct should never be undefined pre UBA");
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  return FILL_DEPOSIT_COMPARISON_KEYS.every((key) => {
    return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
  });
}

/**
 * Resolves the corresponding deposit for a fill. Unlike in the Pre UBA clients, this function does NOT
 * fall back to querying fresh RPC events to try to find a fill. Instead, if the deposit can't be found
 * then this code will just crash, protecting the caller's funds. This is because if we were to find an old
 * deposit, we'd need to recompute its expected realizedLpFeePct, which would be based on the deposit balancing
 * fee and therefore requires more information from the flows preceding it. This is a future TODO.
 * @param fill The fill to resolve the corresponding deposit for
 * @param spokePoolClients The spoke clients to query for the deposit
 * @returns The corresponding deposit for the fill, or undefined if the deposit was not found
 */
export async function resolveCorrespondingDepositForFill(
  fill: FillWithBlock,
  spokePoolClients: SpokePoolClients,
  hubPoolClient: HubPoolClient
): Promise<DepositWithBlock | undefined> {
  // Matched deposit for fill was not found in spoke client. This situation should be rare so let's
  // send some extra RPC requests to blocks older than the spoke client's initial event search config
  // to find the deposit if it exists.
  return queryHistoricalDepositForFill(hubPoolClient, spokePoolClients, fill);
}

// of a deposit older or younger than its fixed lookback.
export async function queryHistoricalDepositForFill(
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClients,
  fill: Fill
): Promise<DepositWithBlock | undefined> {
  const originSpokePoolClient = spokePoolClients[fill.originChainId];

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!originSpokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  // If someone fills with a clearly bogus deposit ID then we can quickly mark it as invalid
  if (
    fill.depositId < originSpokePoolClient.firstDepositIdForSpokePool ||
    fill.depositId > originSpokePoolClient.lastDepositIdForSpokePool
  ) {
    return undefined;
  }

  if (
    fill.depositId >= originSpokePoolClient.earliestDepositIdQueried &&
    fill.depositId <= originSpokePoolClient.latestDepositIdQueried
  ) {
    return originSpokePoolClient.getDepositForFill(fill);
  }

  // At this stage, deposit is not in spoke pool client's search range. Perform an expensive, additional data query
  // to try to validate this deposit.
  const timerStart = Date.now();
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Loading historical bundle to try to find matching deposit for fill",
    fill,
  });
  const deposit: DepositWithBlock = await originSpokePoolClient.findDeposit(
    fill.depositId,
    fill.destinationChainId,
    fill.depositor
  );
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Found matching deposit candidate for fill, fetching bundle data to set fees",
    timeElapsed: Date.now() - timerStart,
    deposit,
  });
  const depositFees = await getModifiedFlow(deposit.originChainId, deposit, hubPoolClient, spokePoolClients);
  hubPoolClient.logger.debug({
    at: "queryHistoricalDepositForFill",
    message: "Recomputed deposit realizedLpFee",
    timeElapsed: Date.now() - timerStart,
    depositFees,
  });
  deposit.realizedLpFeePct = depositFees.systemFee.systemFee;
  return validateFillForDeposit(fill, deposit) ? deposit : undefined;
}
