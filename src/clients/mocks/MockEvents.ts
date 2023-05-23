import { Result } from "@ethersproject/abi";
import { utils as ethersUtils, Event, providers } from "ethers";
import { random } from "lodash";

const { id, keccak256, toUtf8Bytes } = ethersUtils;

type Block = providers.Block;
type TransactionResponse = providers.TransactionResponse;
type TransactionReceipt = providers.TransactionReceipt;

type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  args: Result;
  data?: string;
  blockNumber?: number;
  transactionIndex?: number;
};

const getBlock = async (): Promise<Block> => {
  throw new Error("getBlock() not supported");
};
const getTransaction = async (): Promise<TransactionResponse> => {
  throw new Error("getTransaction() not supported");
};
const getTransactionReceipt = async (): Promise<TransactionReceipt> => {
  throw new Error("getTransactionReceipt() not supported");
};
const removeListener = (): void => {
  throw new Error("removeListener not supported");
};

export class EventManager {
  private logIndexes: Record<string, number> = {};

  constructor(public readonly eventSignatures: Record<string, string>) {}

  generateEvent(inputs: EthersEventTemplate): Event {
    const { address, event, topics: _topics, data, args } = inputs;
    const eventSignature = `${event}(${this.eventSignatures[event]})`;
    const topics = [keccak256(toUtf8Bytes(eventSignature))].concat(_topics);

    let { blockNumber, transactionIndex } = inputs;

    blockNumber = blockNumber ?? random(1, 100_000, false);
    transactionIndex = transactionIndex ?? random(1, 32, false);
    const transactionHash = id(`Across-v2-${event}-${blockNumber}-${transactionIndex}-${random(1, 100_000)}`);

    const _logIndex = `${blockNumber}-${transactionIndex}`;
    this.logIndexes[_logIndex] = this.logIndexes[_logIndex] ?? 0;
    const logIndex = this.logIndexes[_logIndex]++;

    const decodeError = new Error(`${event} decoding error`);

    return {
      blockNumber,
      transactionIndex,
      logIndex,
      transactionHash,
      removed: false,
      address,
      data: data ?? id(`Across-v2-random-txndata-${random(1, 100_000)}`),
      topics,
      args,
      blockHash: id(`Across-v2-blockHash-${random(1, 100_000)}`),
      event,
      eventSignature,
      decodeError,
      getBlock,
      getTransaction,
      getTransactionReceipt,
      removeListener,
    } as Event;
  }
}
