import assert from "assert";
import { utils as ethersUtils } from "ethers";
import { random } from "lodash";
import { Log } from "../../interfaces";
import { isDefined } from "../../utils";

const { id, keccak256, toUtf8Bytes } = ethersUtils;
export type EventOverrides = {
  blockNumber?: number;
};

type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  data?: string;
  blockNumber?: number;
  transactionIndex?: number;
};

const eventManagers: { [chainId: number]: EventManager } = {};

export class EventManager {
  private logIndexes: Record<string, number> = {};
  public events: Log[] = [];
  public readonly minBlockRange = 10;
  public readonly eventSignatures: Record<string, string> = {};

  constructor(public blockNumber = 0) {}

  addEventSignatures(eventSignatures: Record<string, string>): void {
    Object.entries(eventSignatures).forEach(([event, signature]) => {
      if (isDefined(this.eventSignatures[event])) {
        assert(signature === this.eventSignatures[event], `Event ${event} conflict detected.`);
      }
      this.eventSignatures[event] = signature;
    });
  }

  addEvent(event: Log): void {
    this.events.push(event);
  }

  getEvents(): Log[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  generateEvent(inputs: EthersEventTemplate): Log {
    const { address, event, topics, data, args } = inputs;
    let { blockNumber, transactionIndex } = inputs;
    const eventSignature = `${event}(${this.eventSignatures[event]})`;

    // Increment the block number by at least 1, by default. The caller may override
    // to force the same block number to be used, but never a previous block number.
    blockNumber ??= random(this.blockNumber + 1, this.blockNumber + this.minBlockRange, false);
    assert(blockNumber >= this.blockNumber, `${blockNumber} < ${this.blockNumber}`);
    this.blockNumber = blockNumber;
    transactionIndex ??= random(1, 32, false);

    const _logIndex = `${blockNumber}-${transactionIndex}`;
    this.logIndexes[_logIndex] ??= 0;

    const generatedEvent = {
      event,
      blockNumber,
      transactionIndex,
      logIndex: this.logIndexes[_logIndex]++,
      transactionHash: id(`Across-${event}-${blockNumber}-${transactionIndex}-${random(1, 100_000)}`),
      removed: false,
      address,
      data: data ?? id(`Across-random-txndata-${random(1, 100_000)}`),
      topics: [keccak256(toUtf8Bytes(eventSignature)), ...topics],
      args,
      blockHash: id(`Across-blockHash-${random(1, 100_000)}`),
    };

    this.addEvent(generatedEvent);
    return generatedEvent;
  }
}

/**
 * @description Retrieve an instance of the EventManager for a specific chain, or instantiate a new one.
 * @param chainId Chain ID to retrieve EventManager for.
 * @param eventSignatures Event Signatures to append to EventManager instance.
 * @param Initial blockNumber to use if a new EventManager is instantiated.
 * @returns EventManager instance for chain ID.
 */
export function getEventManager(
  chainId: number,
  eventSignatures?: Record<string, string>,
  blockNumber?: number
): EventManager {
  if (!isDefined(eventManagers[chainId])) {
    eventManagers[chainId] = new EventManager(blockNumber);
  }
  const eventManager = eventManagers[chainId];
  if (isDefined(eventSignatures)) {
    eventManager.addEventSignatures(eventSignatures);
  }
  return eventManager;
}
