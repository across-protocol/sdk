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

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  return FILL_DEPOSIT_COMPARISON_KEYS.every((key) => {
    return fill[key] !== undefined && fill[key].toString() === deposit[key]?.toString();
  });
}

/**
 * Resolves the corresponding deposit for a fill. This function will first check the spoke client's deposit cache
 * for the deposit. If the deposit is not found, it will query the spoke client's RPC provider for the deposit as
 * it assumes that the deposit is older than the spoke client's initial event search config.
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

  const deposit: DepositWithBlock = await spokePoolClient.findDeposit(
    fill.depositId,
    fill.destinationChainId,
    fill.depositor
  );

  return validateFillForDeposit(fill, deposit) ? deposit : undefined;
}
