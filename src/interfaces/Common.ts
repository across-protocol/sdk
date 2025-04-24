import { Log as _Log } from "@ethersproject/abstract-provider";
import { BigNumber } from "../utils";

export type Log = _Log & {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: { [key: string]: any };
};

export interface SortableEvent {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
}

export interface BigNumberForToken {
  [l1TokenAddress: string]: BigNumber;
}
