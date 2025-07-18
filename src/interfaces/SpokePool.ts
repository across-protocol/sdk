import { SortableEvent } from "./Common";
import { SpokePoolClient } from "../clients";
import { BigNumber, Address, EvmAddress } from "../utils";
import { RelayerRefundLeaf } from "./HubPool";

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

export interface ConvertedRelayData
  extends Omit<RelayData, "depositor" | "recipient" | "inputToken" | "outputToken" | "exclusiveRelayer"> {
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  exclusiveRelayer: string;
}

export interface SpeedUpCommon {
  updatedRecipient: Address;
  updatedOutputAmount: BigNumber;
  updatedMessage: string;
}

export interface Deposit extends RelayData, Partial<SpeedUpCommon> {
  messageHash: string;
  destinationChainId: number;
  quoteTimestamp: number;
  speedUpSignature?: string;
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

export interface ConvertedFill
  extends Omit<
    Fill,
    "depositor" | "recipient" | "inputToken" | "outputToken" | "exclusiveRelayer" | "relayer" | "relayExecutionInfo"
  > {
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  exclusiveRelayer: string;
  relayer: string;
  relayExecutionInfo: Omit<RelayExecutionEventInfo, "updatedRecipient"> & { updatedRecipient: string };
}

export interface FillWithBlock extends Fill, SortableEvent {}
export interface FillWithTime extends Fill, SortableEvent {
  fillTimestamp: number;
}

export interface EnabledDepositRoute {
  originToken: Address;
  destinationChainId: number;
  enabled: boolean;
}

export interface EnabledDepositRouteWithBlock extends EnabledDepositRoute, SortableEvent {}
export interface SpeedUp extends SpeedUpCommon {
  depositor: EvmAddress;
  depositorSignature: string;
  depositId: BigNumber;
  originChainId: number;
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
  l2TokenAddress: Address;
}

export interface ClaimedRelayerRefundWithBlock extends SortableEvent {
  l2TokenAddress: string;
  refundAddress: string;
  amount: BigNumber;
  caller?: string;
}

export interface BridgedToHubPoolWithBlock extends SortableEvent {
  amount: BigNumber;
  mint: string;
}

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}
