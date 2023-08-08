import { BigNumber } from "ethers";

export interface SortableEvent {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
}

export interface BigNumberForToken {
  [l1TokenAddress: string]: BigNumber;
}

export interface _Block {
  hash: string;
  parentHash: string;
  number: number;

  timestamp: number;
  nonce: string;
  difficulty: number;
  _difficulty: BigNumber;

  gasLimit: BigNumber;
  gasUsed: BigNumber;

  miner: string;
  extraData: string;

  baseFeePerGas?: null | BigNumber;
}

export interface Block extends _Block {
  transactions: Array<string>;
}
