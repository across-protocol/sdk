import { BigNumber } from "ethers";
import { FillWithBlock, UBADepositWithBlock, UBAFillWithBlock, UBARefundRequestWithBlock } from "./";

export type UbaInflow = UBADepositWithBlock;
export type UbaOutflow = (UBAFillWithBlock | UBARefundRequestWithBlock) & { matchedDeposit: UBADepositWithBlock };
export type UbaFlow = UbaInflow | UbaOutflow;

export const isUbaInflow = (flow: UbaFlow): flow is UbaInflow => {
  return (flow as UbaInflow)?.quoteTimestamp !== undefined;
};

export const isUbaOutflow = (flow: UbaFlow): flow is UbaOutflow => {
  return !isUbaInflow(flow) && (outflowIsFill(flow) || outflowIsRefund(flow));
};

export const outflowIsFill = (
  outflow: UbaOutflow
): outflow is UBAFillWithBlock & { matchedDeposit: UBADepositWithBlock } => {
  return (outflow as FillWithBlock)?.updatableRelayData !== undefined;
};

export const outflowIsRefund = (
  outflow: UbaOutflow
): outflow is UBARefundRequestWithBlock & { matchedDeposit: UBADepositWithBlock } => {
  return (outflow as UBARefundRequestWithBlock)?.fillBlock !== undefined;
};

export type UBASpokeBalanceType = {
  chainId: number;
  blockNumber: number;
  lastValidatedRunningBalance?: BigNumber;
  recentRequestFlow: UbaFlow[];
};

export type UBAFeeResult = { depositorFee: BigNumber; refundFee: BigNumber; totalUBAFee: BigNumber };
