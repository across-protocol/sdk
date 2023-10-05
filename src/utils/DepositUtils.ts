import assert from "assert";
import { SpokePoolClient } from "../clients";
import { Fill, DepositWithBlock, Deposit, CachingMechanismInterface } from "../interfaces";
import { validateFillForDeposit } from "./FlowUtils";
import { getCurrentTime } from "./TimeUtils";
import { isDefined } from "./TypeGuards";
import { getDepositInCache, getDepositKey, setDepositInCache } from "./CachingUtils";
import { DEFAULT_CACHING_TTL, ZERO_ADDRESS } from "../constants";
import { resolveContractFromSymbol } from "./TokenUtils";
import { BigNumberish, bnZero, toBN } from "./BigNumberUtils";

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.

/**
 * Attempts to resolve a deposit for a fill. If the fill's deposit Id is within the spoke pool client's search range,
 * the deposit is returned immediately. Otherwise, the deposit is queried first from the provided cache, and if it is
 * not found in the cache, it is queried from the spoke pool client. If the deposit is found, it is cached before
 * being returned.
 * @param spokePoolClient The spoke pool client to use to query the deposit.
 * @param fill The fill to resolve a deposit for.
 * @param cache An optional cache to use to store the deposit. Optional.
 * @returns The deposit for the fill, or undefined if the deposit could not be found.
 * @throws If the fill's origin chain ID does not match the spoke pool client's chain ID.
 * @throws If the spoke pool client has not been updated.
 */
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill,
  cache?: CachingMechanismInterface
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

  let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
  if (cache) {
    cachedDeposit = await getDepositInCache(getDepositKey(fill), cache);
  }

  if (isDefined(cachedDeposit)) {
    deposit = cachedDeposit as DepositWithBlock;
    // Assert that cache hasn't been corrupted.
    assert(deposit.depositId === fill.depositId && deposit.originChainId === fill.originChainId);
  } else {
    deposit = await spokePoolClient.findDeposit(fill.depositId, fill.destinationChainId, fill.depositor);

    if (cache) {
      await setDepositInCache(deposit, getCurrentTime(), cache, DEFAULT_CACHING_TTL);
    }
  }

  return validateFillForDeposit(fill, deposit) ? deposit : undefined;
}

export function createDepositForSimulatingGas(
  amountToRelay: BigNumberish,
  tokenSymbol: string,
  originChainId: string,
  destinationChainId: string,
  relayerAddress: string,
  messagePayload?: {
    message: string;
    recipientAddress: string;
  }
): Deposit {
  const originToken = resolveContractFromSymbol(tokenSymbol, originChainId);
  const destinationToken = resolveContractFromSymbol(tokenSymbol, destinationChainId);
  if (!isDefined(originToken) || !isDefined(destinationToken)) {
    throw new Error(`Could not resolve token contract for ${tokenSymbol} on ${originChainId} or ${destinationChainId}`);
  }

  return {
    // We want to set the deposit ID to 0 so that there
    // is no chance of a collision with a real deposit
    depositId: 0,
    amount: toBN(amountToRelay),
    depositor: relayerAddress ?? ZERO_ADDRESS,
    destinationChainId: Number(destinationChainId),
    originChainId: Number(originChainId),
    message: messagePayload?.message ?? "0x",
    originToken,
    destinationToken,
    recipient: messagePayload?.recipientAddress ?? ZERO_ADDRESS,
    relayerFeePct: bnZero,
    realizedLpFeePct: bnZero,
    quoteTimestamp: getCurrentTime(),
  };
}
