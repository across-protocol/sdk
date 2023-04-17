import { BigNumber } from "ethers";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "./";

export type UbaInflow = DepositWithBlock;
export type UbaOutflow = FillWithBlock | RefundRequestWithBlock;
export type UbaFlow = UbaInflow | UbaOutflow;

export type UbaRunningRequest = {
  type: "refund" | "deposit";
  amount: BigNumber;
};
