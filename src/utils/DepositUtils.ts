// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill

import { SpokePoolClient } from "../clients";
import { DepositWithBlock, Fill } from "../interfaces";
import { validateFillForDeposit } from "./FillUtils";

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
