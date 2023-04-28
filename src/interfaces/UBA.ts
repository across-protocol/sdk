import { BigNumber } from "ethers";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "./";

export type UbaInflow = DepositWithBlock;
export type UbaOutflow = FillWithBlock | RefundRequestWithBlock;
export type UbaFlow = UbaInflow | UbaOutflow;

export type UbaRunningRequest = {
  type: "refund" | "deposit";
  amount: BigNumber;
};

export const isUbaInflow = (flow: UbaFlow): flow is UbaInflow => {
  return (flow as UbaInflow)?.quoteTimestamp !== undefined;
};

export const isUbaOutflow = (flow: UbaFlow): flow is UbaOutflow => {
  return !isUbaInflow(flow) && (outflowIsFill(flow) || outflowIsRefund(flow));
};

export const outflowIsFill = (outflow: UbaOutflow): outflow is FillWithBlock => {
  return (outflow as FillWithBlock)?.repaymentChainId !== undefined;
};

export const outflowIsRefund = (outflow: UbaOutflow): outflow is RefundRequestWithBlock => {
  return (outflow as RefundRequestWithBlock)?.fillBlock !== undefined;
};

export type UBASpokeBalanceType = {
  chainId: number;
  blockNumber: number;
  lastValidatedRunningBalance?: BigNumber;
  recentRequestFlow: UbaFlow[];
};

export type UBAFeeResult = { depositorFee: BigNumber; relayerFee: BigNumber; totalUBAFee: BigNumber };

export type UBAFlowRange = { startIndex: number; endIndex: number };
