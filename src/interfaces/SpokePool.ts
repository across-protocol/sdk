import { BigNumber } from "ethers";
import { SortableEvent } from "./Common";
import { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent } from "../typechain";
import { SpokePoolClient } from "../clients";
import { RelayerRefundLeaf } from "./HubPool";

export type { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent };

export interface RelayData {
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

export interface Deposit extends RelayData {
  destinationChainId: number;
  quoteTimestamp: number;
  realizedLpFeePct?: BigNumber;
  relayerFeePct?: BigNumber;
  speedUpSignature?: string;
  updatedRecipient?: string;
  updatedOutputAmount?: BigNumber;
  updatedMessage?: string;
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
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
  fillType: FillType;
}

export interface Fill extends RelayData {
  destinationChainId: number;
  relayer: string;
  repaymentChainId: number;
  relayExecutionInfo: RelayExecutionEventInfo;
}

export interface FillWithBlock extends Fill, SortableEvent {}

export interface SpeedUp {
  depositor: string;
  depositorSignature: string;
  depositId: number;
  originChainId: number;
  updatedRecipient: string;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
}

export interface SlowFillRequest extends RelayData {
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
