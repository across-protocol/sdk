import { SpokePoolClient } from "../clients";
import { Deposit, DepositWithBlock, Fill, FillWithBlock } from "../interfaces";
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
  spokePoolClients: SpokePoolClients
): Promise<DepositWithBlock | undefined> {
  // Matched deposit for fill was not found in spoke client. This situation should be rare so let's
  // send some extra RPC requests to blocks older than the spoke client's initial event search config
  // to find the deposit if it exists.
  const spokePoolClient = spokePoolClients[fill.originChainId];
  return queryHistoricalDepositForFill(spokePoolClient, fill);
}

// of a deposit older or younger than its fixed lookback.
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill
): Promise<DepositWithBlock | undefined> {
  if (fill.originChainId !== spokePoolClient.chainId) {
    throw new Error(`OriginChainId mismatch (${fill.originChainId} != ${spokePoolClient.chainId})`);
  }

  // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
  // as the global first and last deposit ID's for this spoke pool.
  if (!spokePoolClient.isUpdated) {
    throw new Error("SpokePoolClient must be updated before querying historical deposits");
  }

  // If someone fills with a clearly bogus deposit ID then we can quickly mark it as invalid
  if (
    fill.depositId < spokePoolClient.firstDepositIdForSpokePool ||
    fill.depositId > spokePoolClient.lastDepositIdForSpokePool
  ) {
    return undefined;
  }

  if (
    fill.depositId >= spokePoolClient.earliestDepositIdQueried &&
    fill.depositId <= spokePoolClient.latestDepositIdQueried
  ) {
    return spokePoolClient.getDepositForFill(fill);
  }

  // Unlike in the Pre UBA clients, this function does NOT
  // fall back to querying fresh RPC events to try to find a fill. Instead, if the deposit can't be found
  // then this code will just crash, protecting the caller's funds. This is because if we were to find an old
  // deposit, we'd need to recompute its expected realizedLpFeePct, which would be based on the deposit balancing
  // fee and therefore requires more information from the flows preceding it. This is a future TODO.
  // The downside of not implementing this is that filling an old deposit will cause the UBAClient to crash until
  // its lookback is extended, which then makes it run very slowly. The implementation should reconstruct the bundle
  // state containing the deposit (if it exists) and then use that to compute the deposit balancing fee.
  throw new Error(
    `Can't find historical deposit for fill ${fill.depositId} and haven't implemented historical lookups of deposits in UBA model outside of initial SpokePoolClient search`
  );
}
