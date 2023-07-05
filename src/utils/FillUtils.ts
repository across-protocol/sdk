import { Deposit, DepositWithBlock, Fill, FillWithBlock } from "../interfaces";
import { queryHistoricalDepositForFill } from "./DepositUtils";
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
  const originClient = spokePoolClients[fill.originChainId];
  const matchedDeposit = originClient.getDepositForFill(fill);
  if (matchedDeposit) {
    return matchedDeposit;
  } else {
    // Matched deposit for fill was not found in spoke client. This situation should be rare so let's
    // send some extra RPC requests to blocks older than the spoke client's initial event search config
    // to find the deposit if it exists.
    const spokePoolClient = spokePoolClients[fill.originChainId];
    const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient, fill);
    if (historicalDeposit) {
      return historicalDeposit;
    } else {
      return undefined;
    }
  }
}
