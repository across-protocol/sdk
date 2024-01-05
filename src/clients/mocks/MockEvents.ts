import assert from "assert";
import { utils as ethersUtils, Event, providers } from "ethers";
import { random } from "lodash";
import { isDefined, randomAddress, toBN } from "../../utils";

const { id, keccak256, toUtf8Bytes } = ethersUtils;
export type EventOverrides = {
  blockNumber?: number;
};

type Block = providers.Block;
type TransactionResponse = providers.TransactionResponse;
type TransactionReceipt = providers.TransactionReceipt;

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

// May need to populate getTransaction and getTransactionReceipt if calling code starts using it.
// https://docs.ethers.org/v5/api/providers/provider/#Provider-getTransaction
const getTransaction = (): Promise<TransactionResponse> => {
  throw new Error("getTransaction() not supported");
};
// https://docs.ethers.org/v5/api/providers/provider/#Provider-getTransactionReceipt
const getTransactionReceipt = (): Promise<TransactionReceipt> => {
  throw new Error("getTransactionReceipt() not supported");
};
const removeListener = (): void => {
  throw new Error("removeListener not supported");
};

export class EventManager {
  private logIndexes: Record<string, number> = {};
  public events: Event[] = [];
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

  addEvent(event: Event): void {
    this.events.push(event);
  }

  getEvents(): Event[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  generateEvent(inputs: EthersEventTemplate): Event {
    const { address, event, topics: _topics, data, args } = inputs;
    const eventSignature = `${event}(${this.eventSignatures[event]})`;
    const topics = [keccak256(toUtf8Bytes(eventSignature))].concat(_topics);

    let { blockNumber, transactionIndex } = inputs;

    // Increment the block number by at least 1, by default. The caller may override
    // to force the same block number to be used, but never a previous block number.
    blockNumber ??= random(this.blockNumber + 1, this.blockNumber + this.minBlockRange, false);
    assert(blockNumber >= this.blockNumber, `${blockNumber} < ${this.blockNumber}`);
    this.blockNumber = blockNumber;

    transactionIndex ??= random(1, 32, false);
    const transactionHash = id(`Across-v2-${event}-${blockNumber}-${transactionIndex}-${random(1, 100_000)}`);

    const _logIndex = `${blockNumber}-${transactionIndex}`;
    this.logIndexes[_logIndex] ??= 0;
    const logIndex = this.logIndexes[_logIndex]++;

    const decodeError = new Error(`${event} decoding error`);
    const parentHash = id(`Across-v2-blockHash-${random(1, 100_000)}`);
    const blockHash = id(`Across-v2-blockHash-${parentHash}-${random(1, 100_000)}`);

    // getBlock() may later be used to retrieve (for example) the block timestamp.
    // @todo: If multiple events coincide on the same block number, this callback should return the same Block object.
    const getBlock = (): Promise<Block> => {
      return Promise.resolve({
        hash: blockHash,
        parentHash,
        number: blockNumber as number,
        timestamp: Math.floor(Date.now() / 1000),
        nonce: "",
        difficulty: random(1, 1000, false),
        _difficulty: toBN(random(1, 1000, false)),
        gasLimit: toBN(random(1_000_000, 10_000_000, false)),
        gasUsed: toBN(random(1, 1000, false)),
        miner: randomAddress(),
        extraData: `Block containing test transaction ${transactionHash}.`,
        transactions: [transactionHash],
      });
    };

    const generatedEvent = {
      blockNumber,
      transactionIndex,
      logIndex,
      transactionHash,
      removed: false,
      address,
      data: data ?? id(`Across-v2-random-txndata-${random(1, 100_000)}`),
      topics,
      args,
      blockHash,
      event,
      eventSignature,
      decodeError,
      getBlock,
      getTransaction,
      getTransactionReceipt,
      removeListener,
    } as Event;

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
