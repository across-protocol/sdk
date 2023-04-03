// import { DepositWithBlock, FillWithBlock, RefundRequestedWithBlock } from "./SpokePool";
import { DepositWithBlock, FillWithBlock } from "./SpokePool";

export type UbaInflow = DepositWithBlock;
// export type UbaOutflow = FillWithBlock | RefundRequestedWithBlock;
export type UbaOutflow = FillWithBlock;
export type UbaFlow = UbaInflow | UbaOutflow;
