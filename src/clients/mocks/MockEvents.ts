import { utils as ethersUtils, Event, providers } from "ethers";
import { random } from "lodash";
import { toBN, randomAddress } from "../../utils";

const { id, keccak256, toUtf8Bytes } = ethersUtils;

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

// May need to populate getTransaction and getTransactionReceipt if calling code starts using it.
// https://docs.ethers.org/v5/api/providers/provider/#Provider-getTransaction
const getTransaction = async (): Promise<TransactionResponse> => {
  throw new Error("getTransaction() not supported");
};
// https://docs.ethers.org/v5/api/providers/provider/#Provider-getTransactionReceipt
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
    const parentHash = id(`Across-v2-blockHash-${random(1, 100_000)}`);
    const blockHash = id(`Across-v2-blockHash-${parentHash}-${random(1, 100_000)}`);

    // getBlock() may later be used to retrieve (for example) the block timestamp.
    const getBlock = async (): Promise<Block> => {
      return {
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
      };
    };

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
      blockHash,
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
