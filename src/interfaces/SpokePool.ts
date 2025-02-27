import { SortableEvent } from "./Common";
import { FilledV3RelayEvent, V3FundsDepositedEvent } from "../typechain";
import { SpokePoolClient } from "../clients";
import { BigNumber, Address } from "../utils";
import { RelayerRefundLeaf } from "./HubPool";

export type { FilledV3RelayEvent, V3FundsDepositedEvent };

export interface RelayData {
  originChainId: number;
  depositor: Address;
  recipient: Address;
  depositId: BigNumber;
  inputToken: Address;
  inputAmount: BigNumber;
  outputToken: Address;
  outputAmount: BigNumber;
  message: string;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
}

export interface Deposit extends RelayData {
  messageHash: string;
  destinationChainId: number;
  quoteTimestamp: number;
  speedUpSignature?: string;
  updatedRecipient?: Address;
  updatedOutputAmount?: BigNumber;
  updatedMessage?: string;
  fromLiteChain: boolean;
  toLiteChain: boolean;
}

export interface DepositWithBlock extends Deposit, SortableEvent {
  quoteBlockNumber: number;
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
  updatedRecipient: Address;
  updatedOutputAmount: BigNumber;
  updatedMessage?: string;
  updatedMessageHash: string;
  fillType: FillType;
}

export interface Fill extends Omit<RelayData, "message"> {
  messageHash: string;
  destinationChainId: number;
  relayer: Address;
  repaymentChainId: number;
  relayExecutionInfo: RelayExecutionEventInfo;
}

export interface FillWithBlock extends Fill, SortableEvent {}

export interface SpeedUp {
  depositor: Address;
  depositorSignature: string;
  depositId: BigNumber;
  originChainId: number;
  updatedRecipient: Address;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
}

export interface SpeedUpWithBlock extends SpeedUp, SortableEvent {}

export interface SlowFillRequest extends RelayData {
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
  l2TokenAddress: Address;
}

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}
