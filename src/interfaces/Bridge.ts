import { BigNumber } from "../utils/BigNumberUtils";

export interface OutstandingTransfers {
  [address: string]: {
    [l1Token: string]: {
      totalAmount: BigNumber;
      depositTxHashes: string[];
    };
  };
}
