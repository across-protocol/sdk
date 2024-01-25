import { BigNumber } from "ethers";
import { DepositWithBlock, FillWithBlock } from "./";

export type UbaInflow = DepositWithBlock;
export type UbaOutflow = FillWithBlock & { matchedDeposit: DepositWithBlock };
export type UbaFlow = UbaInflow | UbaOutflow;

export const isUbaInflow = (flow: UbaFlow): flow is UbaInflow => {
  return (flow as UbaInflow)?.quoteTimestamp !== undefined;
};

export const isUbaOutflow = (flow: UbaFlow): flow is UbaOutflow => {
  return !isUbaInflow(flow) && outflowIsFill(flow);
};

export const outflowIsFill = (outflow: UbaOutflow): outflow is FillWithBlock & { matchedDeposit: DepositWithBlock } => {
  return (outflow as FillWithBlock)?.updatableRelayData !== undefined;
};

export type UBASpokeBalanceType = {
  chainId: number;
  blockNumber: number;
  lastValidatedRunningBalance?: BigNumber;
  recentRequestFlow: UbaFlow[];
};

export type UBAFeeResult = { depositorFee: BigNumber; refundFee: BigNumber; totalUBAFee: BigNumber };
