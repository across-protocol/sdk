import { BigNumber } from "ethers";
import { ChainId } from "../adapters/web3/model";

export type TransferStatus = "pending" | "filled";

export type Transfer = {
  depositId: number;
  depositTime: number;
  status: TransferStatus;
  filled: BigNumber;
  sourceChainId: ChainId;
  destinationChainId: number;
  assetAddr: string;
  amount: BigNumber;
  depositTxHash: string;
};
