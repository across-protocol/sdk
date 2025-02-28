import { Result } from "@ethersproject/abi";
// eslint-disable-next-line no-restricted-imports
import { Contract, Event, EventFilter } from "ethers";
import { Log, SortableEvent } from "../interfaces";
import { delay } from "./common";
import { isDefined, toBN, BigNumberish, Address } from "./";

const maxRetries = 3;
const retrySleepTime = 10;

// Event fields which must be mutated to a custom `Address` type.
const addressFields = new Set<string>([
  // / Spoke Pool Fields
  // TokensBridged
  "l2TokenAddress",
  // FundsDeposited/FilledRelay/RequestedSlowFill
  "inputToken",
  "outputToken",
  "depositor",
  "recipient",
  "exclusiveRelayer",
  // FilledRelay
  "relayer",
  // RequestedSpeedUpDeposit
  "updatedRecipient",
  // ClaimedRelayerRefund
  "refundAddress",
  "caller",
  // ExecutedRelayerRefundRoot
  "refundAddresses",

  // / Hub Pool Fields
  // ProposeRootBundle
  "proposer",
  // CrossChainContractsSet
  "adapter",
  "spokePool",
  // *ForLiquidityProvision
  "l1Token",
  "lpToken",
  // Liquidity*
  "liquidityProvider",
  // SetPoolRebalanceRoute
  "destinationToken",
  // SetEnableDepositRoute
  "originToken",
  // RootBundleDisputed
  "disputer",
  // ExecutedRootBundle
  "l1Tokens",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function spreadEvent(args: Result | Record<string, unknown>): { [key: string]: any } {
  const keys = Object.keys(args).filter((key: string) => isNaN(+key)); // Extract non-numeric keys.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const returnedObject: { [key: string]: unknown } = {};
  keys.forEach((key: string) => {
    switch (typeof args[key]) {
      case "boolean": // fallthrough
      case "number":
      case "string":
        returnedObject[key] = args[key];
        break;
      case "object":
        if (Array.isArray(args[key])) {
          returnedObject[key] =
            Object.keys(args[key]).filter((key: string) => isNaN(+key)).length > 0
              ? spreadEvent(args[key]) // Record/array hybrid...
              : args[key]; // Just an array
        } else {
          returnedObject[key] = args[key];
        }
        break;
    }
  });

  // ID information, if included in an event, should be cast to a number rather than a BigNumber.
  if (returnedObject.groupIndex) {
    returnedObject.groupIndex = Number(returnedObject.groupIndex);
  }
  if (returnedObject.leafId) {
    returnedObject.leafId = Number(returnedObject.leafId);
  }
  if (returnedObject.chainId) {
    returnedObject.chainId = Number(returnedObject.chainId);
  }
  if (returnedObject.destinationChainId) {
    returnedObject.destinationChainId = Number(returnedObject.destinationChainId);
  }
  if (returnedObject.originChainId) {
    returnedObject.originChainId = Number(returnedObject.originChainId);
  }
  if (returnedObject.repaymentChainId) {
    returnedObject.repaymentChainId = Number(returnedObject.repaymentChainId);
  }
  if (returnedObject.l2ChainId) {
    returnedObject.l2ChainId = Number(returnedObject.l2ChainId);
  }
  if (returnedObject.rootBundleId) {
    returnedObject.rootBundleId = Number(returnedObject.rootBundleId);
  }
  // If depositId is included in the event, cast it to a BigNumber. Need to check if it is defined since the deposit ID can
  // be 0, which would still make this evaluate as false.
  if (isDefined(returnedObject.depositId)) {
    // Assuming a numeric output, we can safely cast the unknown to BigNumberish since the depositId will either be a uint32 (and therefore a TypeScript `number`),
    // or a uint256 (and therefore an ethers BigNumber).
    returnedObject.depositId = toBN(returnedObject.depositId as BigNumberish);
  }

  // Truncate all fields which may be bytes32 into a bytes20 string.
  for (const key of keys) {
    if (addressFields.has(key)) {
      // Big TODO: Figure out where to validate that the input address is good, since taking all event addresses and just treating them as only an `Address` type
      // diminishes the utility of having a distinction between `EvmAddress` and `SvmAddress`.
      if (Array.isArray(returnedObject[key])) {
        const mappedAddresses = (returnedObject[key] as unknown[]).map((_address) => Address.from(String(_address)));
        returnedObject[key] = mappedAddresses;
      } else {
        returnedObject[key] = Address.from(String(returnedObject[key]));
      }
    }
  }

  return returnedObject;
}

export interface EventSearchConfig {
  fromBlock: number;
  toBlock: number;
  maxBlockLookBack?: number;
}

export const eventToLog = (event: Event): Log => ({ ...event, event: event.event!, args: spreadEvent(event.args!) });

export async function paginatedEventQuery(
  contract: Contract,
  filter: EventFilter,
  searchConfig: EventSearchConfig,
  retryCount = 0
): Promise<Log[]> {
  // If the max block look back is set to 0 then we dont need to do any pagination and can query over the whole range.
  if (searchConfig.maxBlockLookBack === 0) {
    const events = await contract.queryFilter(filter, searchConfig.fromBlock, searchConfig.toBlock);
    return events.map(eventToLog);
  }

  // Compute the number of queries needed. If there is no maxBlockLookBack set then we can execute the whole query in
  // one go. Else, the number of queries is the range over which we are searching, divided by the maxBlockLookBack,
  // rounded up. This gives us the number of queries we need to execute to traverse the whole block range.
  const paginatedRanges = getPaginatedBlockRanges(searchConfig);

  try {
    return (
      (
        await Promise.all(
          paginatedRanges.map(([fromBlock, toBlock]) => contract.queryFilter(filter, fromBlock, toBlock))
        )
      )
        .flat()
        // Filter events by block number because ranges can include blocks that are outside the range specified for caching reasons.
        .filter((event) => event.blockNumber >= searchConfig.fromBlock && event.blockNumber <= searchConfig.toBlock)
        .map(eventToLog)
    );
  } catch (error) {
    if (retryCount < maxRetries) {
      await delay(retrySleepTime);
      return await paginatedEventQuery(contract, filter, searchConfig, retryCount + 1);
    } else {
      throw error;
    }
  }
}

/**
 * @dev Warning: this is a specialized function!! Its functionality is not obvious.
 * This function attempts to return block ranges to repeat ranges as much as possible. To do so, it may include blocks that
 * are outside the provided range. The guarantee is that it will always include _at least_ the blocks requested.
 * @param eventSearchConfig contains fromBlock, toBlock, and maxBlockLookBack.
 * The range is inclusive, so the results will include events in the fromBlock and in the toBlock.
 * maxBlockLookback defined the maximum number of blocks to search. Because the range is inclusive, the maximum diff
 * in the returned pairs is maxBlockLookBack - 1. This is a bit non-intuitive here, but this is meant so that this
 * parameter more closely aligns with the more commonly understood definition of a max query range that node providers
 * use.
 * @returns an array of disjoint fromBlock, toBlock ranges that should be queried. These cover at least the entire
 * input range, but can include blocks outside of the desired range, so results should be filtered. Results
 * are ordered from smallest to largest.
 */
export function getPaginatedBlockRanges({
  fromBlock,
  toBlock,
  maxBlockLookBack,
}: EventSearchConfig): [number, number][] {
  // If the maxBlockLookBack is undefined, we can look back as far as we like. Just return the entire range.
  if (maxBlockLookBack === undefined) {
    return [[fromBlock, toBlock]];
  }

  // If the fromBlock is > toBlock, then return no ranges.
  if (fromBlock > toBlock) {
    return [];
  }

  // A maxBlockLookBack of 0 is not allowed.
  if (maxBlockLookBack <= 0) {
    throw new Error("Cannot set maxBlockLookBack <= 0");
  }

  // Floor the requestedFromBlock to the nearest smaller multiple of the maxBlockLookBack to enhance caching.
  // This means that a range like 5 - 45 with a maxBlockLookBack of 20 would look like:
  // 0-19, 20-39, 40-45.
  // This allows us to get the max number of repeated node queries. The maximum number of "nonstandard" queries per
  // call of this function is 1.
  const flooredStartBlock = Math.floor(fromBlock / maxBlockLookBack) * maxBlockLookBack;

  // Note: range is inclusive, so we have to add one to the number of blocks to query.
  const iterations = Math.ceil((toBlock + 1 - flooredStartBlock) / maxBlockLookBack);

  const ranges: [number, number][] = [];
  for (let i = 0; i < iterations; i++) {
    // Each inner range start is just a multiple of the maxBlockLookBack added to the start block.
    const innerFromBlock = flooredStartBlock + maxBlockLookBack * i;

    // The innerFromBlock is just the max range from the innerFromBlock or the outer toBlock, whichever is smaller.
    // The end block should never be larger than the outer toBlock. This is to avoid querying blocks that are in the
    // future.
    const innerToBlock = Math.min(innerFromBlock + maxBlockLookBack - 1, toBlock);
    ranges.push([innerFromBlock, innerToBlock]);
  }

  return ranges;
}

export function spreadEventWithBlockNumber(event: Log): SortableEvent {
  return {
    ...spreadEvent(event.args),
    blockNumber: event.blockNumber,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
    transactionHash: event.transactionHash,
  };
}

// This copies the array and sorts it, returning a new array with the new ordering.
export function sortEventsAscending<T extends SortableEvent>(events: T[]): T[] {
  return sortEventsAscendingInPlace([...events]);
}

// This sorts the events in place, meaning it modifies the passed array and returns a reference to the same array.
// Note: this method should only be used in cases where modifications are acceptable.
export function sortEventsAscendingInPlace<T extends SortableEvent>(events: T[]): T[] {
  return events.sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) {
      return ex.blockNumber - ey.blockNumber;
    }
    if (ex.transactionIndex !== ey.transactionIndex) {
      return ex.transactionIndex - ey.transactionIndex;
    }
    return ex.logIndex - ey.logIndex;
  });
}

// This copies the array and sorts it, returning a new array with the new ordering.
export function sortEventsDescending<T extends SortableEvent>(events: T[]): T[] {
  return sortEventsDescendingInPlace([...events]);
}

// This sorts the events in place, meaning it modifies the passed array and returns a reference to the same array.
// Note: this method should only be used in cases where modifications are acceptable.
export function sortEventsDescendingInPlace<T extends SortableEvent>(events: T[]): T[] {
  return events.sort((ex, ey) => {
    if (ex.blockNumber !== ey.blockNumber) {
      return ey.blockNumber - ex.blockNumber;
    }
    if (ex.transactionIndex !== ey.transactionIndex) {
      return ey.transactionIndex - ex.transactionIndex;
    }
    return ey.logIndex - ex.logIndex;
  });
}

// Returns true if ex is older than ey.
export function isEventOlder<T extends SortableEvent>(ex: T, ey: T): boolean {
  if (ex.blockNumber !== ey.blockNumber) {
    return ex.blockNumber < ey.blockNumber;
  }
  if (ex.transactionIndex !== ey.transactionIndex) {
    return ex.transactionIndex < ey.transactionIndex;
  }
  return ex.logIndex < ey.logIndex;
}

export function getTransactionHashes(events: SortableEvent[]): string[] {
  return [...Array.from(new Set(events.map((e) => e.transactionHash)))];
}

export function duplicateEvent(a: SortableEvent, b: SortableEvent): boolean {
  return a.transactionHash === b.transactionHash && a.logIndex === b.logIndex;
}
