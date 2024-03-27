import { BigNumber } from "ethers";
import { SortableEvent } from "./Common";
import { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent } from "../typechain";
import { SpokePoolClient } from "../clients";
import { RelayerRefundLeaf } from "./HubPool";

export type { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent };

export interface V3RelayData {
  originChainId: number;
  depositor: string;
  recipient: string;
  depositId: number;
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  message: string;
  fillDeadline: number;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
}

export type RelayData = V3RelayData;

export interface V3Deposit extends V3RelayData {
  destinationChainId: number;
  quoteTimestamp: number;
  realizedLpFeePct?: BigNumber;
  relayerFeePct?: BigNumber;
  speedUpSignature?: string;
  updatedRecipient?: string;
  updatedOutputAmount?: BigNumber;
  updatedMessage?: string;
}

export interface V3DepositWithBlock extends V3Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export type Deposit = V3Deposit;
export type DepositWithBlock = V3DepositWithBlock;

export enum FillStatus {
  Unfilled = 0,
  RequestedSlowFill,
  Filled,
}

export enum FillType {
  FastFill = 0,
  ReplacedSlowFill,
  SlowFill,
}

export interface V3RelayExecutionEventInfo {
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
  fillType: FillType;
}

export interface V3Fill extends V3RelayData {
  destinationChainId: number;
  relayer: string;
  repaymentChainId: number;
  relayExecutionInfo: V3RelayExecutionEventInfo;
}

export interface V3FillWithBlock extends V3Fill, SortableEvent {}

export type Fill = V3Fill;
export type FillWithBlock = V3FillWithBlock;

export interface V3SpeedUp {
  depositor: string;
  depositorSignature: string;
  depositId: number;
  originChainId: number;
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
}

export type SpeedUp = V3SpeedUp;

export interface SlowFillRequest extends V3RelayData {
  destinationChainId: number;
}
export interface SlowFillRequestWithBlock extends SlowFillRequest, SortableEvent {}

export interface V3SlowFillLeaf {
  relayData: V3RelayData;
  chainId: number;
  updatedOutputAmount: BigNumber;
}

export type SlowFillLeaf = V3SlowFillLeaf;

export interface RootBundleRelay {
  rootBundleId: number;
  relayerRefundRoot: string;
  slowRelayRoot: string;
}

export interface RootBundleRelayWithBlock extends RootBundleRelay, SortableEvent {}

export interface RelayerRefundExecution extends RelayerRefundLeaf {
  rootBundleId: number;
}

export interface RelayerRefundExecutionWithBlock extends RelayerRefundExecution, SortableEvent {}

export interface Refund {
  [refundAddress: string]: BigNumber;
}

export interface RunningBalances {
  [repaymentChainId: number]: {
    [l1TokenAddress: string]: BigNumber;
  };
}

export interface TokensBridged extends SortableEvent {
  amountToReturn: BigNumber;
  chainId: number;
  leafId: number;
  l2TokenAddress: string;
}

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}
