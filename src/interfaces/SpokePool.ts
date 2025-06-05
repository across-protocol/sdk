import { SortableEvent } from "./Common";
import { SpokePoolClient } from "../clients";
import { BigNumber } from "../utils";
import { RelayerRefundLeaf } from "./HubPool";

export interface RelayData {
  originChainId: number;
  depositor: string;
  recipient: string;
  depositId: BigNumber;
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  message: string;
  fillDeadline: number;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
}

export interface Deposit extends RelayData {
  messageHash: string;
  destinationChainId: number;
  quoteTimestamp: number;
  speedUpSignature?: string;
  updatedRecipient?: string;
  updatedOutputAmount?: BigNumber;
  updatedMessage?: string;
  fromLiteChain: boolean;
  toLiteChain: boolean;
}

export interface DepositWithBlock extends Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export interface DepositWithTime extends Deposit, SortableEvent {
  depositTimestamp: number;
}

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

export interface RelayExecutionEventInfo {
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage?: string;
  updatedMessageHash: string;
  fillType: FillType;
}

export interface Fill extends Omit<RelayData, "message"> {
  messageHash: string;
  destinationChainId: number;
  relayer: string;
  repaymentChainId: number;
  relayExecutionInfo: RelayExecutionEventInfo;
}

export interface FillWithBlock extends Fill, SortableEvent {}
export interface FillWithTime extends Fill, SortableEvent {
  fillTimestamp: number;
}

export interface EnabledDepositRoute {
  originToken: string;
  destinationChainId: number;
  enabled: boolean;
}

export interface EnabledDepositRouteWithBlock extends EnabledDepositRoute, SortableEvent {}
export interface SpeedUp {
  depositor: string;
  depositorSignature: string;
  depositId: BigNumber;
  originChainId: number;
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
}

export interface SpeedUpWithBlock extends SpeedUp, SortableEvent {}

export interface SlowFillRequest extends Omit<RelayData, "message"> {
  messageHash: string;
  destinationChainId: number;
}
export interface SlowFillRequestWithBlock extends SlowFillRequest, SortableEvent {}

export interface SlowFillLeaf {
  relayData: RelayData;
  chainId: number;
  updatedOutputAmount: BigNumber;
}

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
