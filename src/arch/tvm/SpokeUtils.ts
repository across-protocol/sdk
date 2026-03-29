import assert from "assert";
import { Contract, providers } from "ethers";
import { CHAIN_IDs } from "../../constants";
import { FillStatus, FillWithBlock, RelayData } from "../../interfaces";
import { get1967Upgrades } from "../evm/UpgradeUtils";
import {
  BigNumber,
  getRelayDataHash,
  isDefined,
  isUnsafeDepositId,
  paginatedEventQuery,
  spreadEventWithBlockNumber,
  unpackFillEvent,
} from "../../utils";

type BlockTag = providers.BlockTag;

// Re-export functions that work unchanged on TRON's JSON-RPC.
export { populateV3Relay, getTimestampForBlock, fillStatusArray } from "../evm/SpokeUtils";

// Local implementations for functions requiring historical eth_call,
// which TRON does not support (only "latest" blockTag is accepted).

/**
 * @notice Retrieve the on-chain time at a specific block number.
 * TRON does not support historical eth_call so block timestamps are used
 * instead of SpokePool.getCurrentTime(). In production these are equivalent.
 */
export async function getTimeAt(spokePool: Contract, blockNumber: number): Promise<number> {
  const block = await spokePool.provider.getBlock(blockNumber);
  return block.timestamp;
}

// Fallback fill deadline buffer (6 hours) used when a contract upgrade is
// detected in the query range. An upgrade implies fillDeadlineBuffer may
// have changed and we cannot read historical state on TRON, so we use a
// conservative upper bound.
const FALLBACK_FILL_DEADLINE_BUFFER = 21600; // 6 hours in seconds

/**
 * @notice Return the maximum fill deadline buffer across a block range.
 * TRON does not support historical eth_call, so we read the current value.
 * If a contract upgrade (EIP-1967 Upgraded event) occurred within the range,
 * the value may have changed at the upgrade boundary. In that case, return
 * the greater of the current value and a conservative 6-hour fallback.
 */
export async function getMaxFillDeadlineInRange(
  spokePool: Contract,
  startBlock: number,
  endBlock: number
): Promise<number> {
  const [fillDeadlineBuffer, upgrades] = await Promise.all([
    spokePool.fillDeadlineBuffer(),
    get1967Upgrades(spokePool, startBlock, endBlock),
  ]);

  const currentBuffer = Number(fillDeadlineBuffer);

  if (upgrades.length > 0) {
    return Math.max(currentBuffer, FALLBACK_FILL_DEADLINE_BUFFER);
  }

  return currentBuffer;
}

/**
 * @notice Not supported on TVM — callers should use findDepositBlock instead.
 */
export function getDepositIdAtBlock(_contract: Contract, _blockTag: number): Promise<BigNumber> {
  throw new Error("getDepositIdAtBlock: not supported on TVM");
}

/**
 * @notice Find the block at which a deposit was created.
 * TRON does not support historical eth_call, so event queries replace the
 * EVM binary-search over numberOfDeposits().
 */
export async function findDepositBlock(
  spokePool: Contract,
  depositId: BigNumber,
  lowBlock: number,
  highBlock?: number
): Promise<number | undefined> {
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot search for depositId ${depositId}`);
  }

  highBlock ??= await spokePool.provider.getBlockNumber();
  assert(highBlock > lowBlock, `Block numbers out of range (${lowBlock} >= ${highBlock})`);

  const events = await paginatedEventQuery(
    spokePool,
    spokePool.filters.FundsDeposited(null, null, null, null, null, depositId),
    { from: lowBlock, to: highBlock }
  );

  if (events.length === 0) {
    return undefined;
  }

  return events[0].blockNumber;
}

/**
 * @notice Determine the fill status of a relay at a given block.
 * For "latest" queries, TRON's eth_call works normally. For historical
 * queries the status is reconstructed from on-chain events.
 */
export async function relayFillStatus(
  spokePool: Contract,
  relayData: RelayData,
  blockTag: BlockTag = "latest",
  destinationChainId?: number
): Promise<FillStatus> {
  destinationChainId ??= await spokePool.chainId();
  assert(isDefined(destinationChainId));

  const hash = getRelayDataHash(relayData, destinationChainId);

  if (blockTag === "latest") {
    const _fillStatus = await spokePool.fillStatuses(hash, { blockTag });
    const fillStatus = Number(_fillStatus);

    if (![FillStatus.Unfilled, FillStatus.RequestedSlowFill, FillStatus.Filled].includes(fillStatus)) {
      const { originChainId, depositId } = relayData;
      throw new Error(
        `relayFillStatus: Unexpected fillStatus for ${originChainId} deposit ${depositId.toString()} (${fillStatus})`
      );
    }

    return fillStatus;
  }

  // Historical blockTag: check the current state first as an optimisation.
  // Fill status can only increase (Unfilled -> RequestedSlowFill -> Filled),
  // so if the deposit is still Unfilled now it was Unfilled at every prior block.
  const latestStatus = Number(await spokePool.fillStatuses(hash));
  if (latestStatus === FillStatus.Unfilled) {
    return FillStatus.Unfilled;
  }

  // Reconstruct from events up to the requested block.
  const fromBlock = 0;
  const toBlock = Number(blockTag);

  const fillEvents = await paginatedEventQuery(
    spokePool,
    spokePool.filters.FilledRelay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
    { from: fromBlock, to: toBlock }
  );

  if (fillEvents.length > 0) {
    return FillStatus.Filled;
  }

  // No fill before blockTag — check for slow fill requests.
  if (latestStatus >= FillStatus.RequestedSlowFill) {
    const slowFillEvents = await paginatedEventQuery(
      spokePool,
      spokePool.filters.RequestedSlowFill(null, null, null, null, relayData.originChainId, relayData.depositId),
      { from: fromBlock, to: toBlock }
    );

    if (slowFillEvents.length > 0) {
      return FillStatus.RequestedSlowFill;
    }
  }

  return FillStatus.Unfilled;
}

/**
 * @notice Find the block at which a fill was completed.
 * TRON does not support historical eth_call, so event queries replace the
 * EVM binary-search over fillStatuses().
 */
export async function findFillBlock(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<number | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} >= ${highBlockNumber})`);

  const events = await paginatedEventQuery(
    spokePool,
    spokePool.filters.FilledRelay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
    { from: lowBlockNumber, to: highBlockNumber }
  );

  if (events.length === 0) {
    return undefined;
  }

  return events[0].blockNumber;
}

/**
 * @notice Find the fill event for a deposit.
 * Queries fill events directly rather than binary-searching then re-querying.
 */
export async function findFillEvent(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<FillWithBlock | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();

  const events = await paginatedEventQuery(
    spokePool,
    spokePool.filters.FilledRelay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
    { from: lowBlockNumber, to: highBlockNumber }
  );

  if (events.length === 0) {
    return undefined;
  }

  const event = events[0];
  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query because the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await spokePool.provider.getNetwork()).chainId
    : Number(await spokePool.chainId());

  return unpackFillEvent(spreadEventWithBlockNumber(event), destinationChainId);
}
