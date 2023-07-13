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

export type TupleParameter = [BigNumber, BigNumber];
export type FlowTupleParameters = TupleParameter[];
export type ThresholdType = { target: BigNumber; threshold: BigNumber };
export type ThresholdBoundType = { lowerBound: ThresholdType; upperBound: ThresholdType };
