import { BigNumber } from "ethers";
import { TokenRunningBalance } from "../interfaces";

export enum UBAActionType {
  Deposit = "deposit",
  Refund = "refund",
}

export type TokenRunningBalanceWithNetSend = TokenRunningBalance & {
  netRunningBalanceAdjustment: BigNumber;
};

export type UBAFlowFee = {
  balancingFee: BigNumber;
};
