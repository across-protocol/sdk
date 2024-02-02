import { BigNumber } from "ethers";
import { SortableEvent } from "./Common";
import { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent } from "../typechain";
import { SpokePoolClient } from "../clients";

export type { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent };

export interface RelayDataCommon {
  originChainId: number;
  depositor: string;
  recipient: string;
  depositId: number;
  message: string;
}

export interface V2RelayData extends RelayDataCommon {
  destinationChainId: number;
  destinationToken: string;
  amount: BigNumber;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
}

export interface V3RelayData extends RelayDataCommon {
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  fillDeadline: number;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
}

// @todo: Extend with V2RelayData | V3RelayData.
export type RelayData = V2RelayData;

export interface V2Deposit extends V2RelayData {
  originToken: string;
  quoteTimestamp: number;
  speedUpSignature?: string;
  updatedRecipient?: string;
  newRelayerFeePct?: BigNumber;
  updatedMessage?: string;
}

export interface V2DepositWithBlock extends V2Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export interface V3Deposit extends V3RelayData {
  destinationChainId: number;
  quoteTimestamp: number;
  updatedOutputAmount?: BigNumber;
  relayerFeePct?: BigNumber;
}

export interface V3DepositWithBlock extends V3Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export type Deposit = V2Deposit; // @todo: Extend with V2Deposit | V3Deposit.
export type DepositWithBlock = V2DepositWithBlock; // @todo Extend with V2DepositWithBlock | V3DepositWithBlock.

export interface RelayExecutionInfoCommon {
  recipient: string;
  message: string;
}

export interface RelayExecutionInfo extends RelayExecutionInfoCommon {
  relayerFeePct: BigNumber;
  isSlowRelay: boolean;
  payoutAdjustmentPct: BigNumber;
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

export interface V3RelayExecutionEventInfo extends RelayExecutionInfoCommon {
  outputAmount: BigNumber;
  fillType: FillType;
}

export interface V2Fill extends V2RelayData {
  fillAmount: BigNumber;
  totalFilledAmount: BigNumber;
  relayer: string;
  repaymentChainId: number;
  updatableRelayData: RelayExecutionInfo;
}

export interface V3Fill extends V3RelayData {
  relayer: string;
  repaymentChainId: number;
  updatableRelayData: V3RelayExecutionEventInfo;
}

export interface V2FillWithBlock extends V2Fill, SortableEvent {}
export interface V3FillWithBlock extends V3Fill, SortableEvent {}

export type Fill = V2Fill; // @todo: Extend with V2Fill | V3Fill.
export type FillWithBlock = V2FillWithBlock; // @todo Extend with V2FillWithBlock | V3FillWithBlock.

export interface SpeedUpCommon {
  depositor: string;
  depositorSignature: string;
  depositId: number;
  originChainId: number;
  updatedRecipient: string;
  updatedMessage: string;
}

export interface V2SpeedUp extends SpeedUpCommon {
  newRelayerFeePct: BigNumber;
}

export interface V3SpeedUp extends SpeedUpCommon {
  updatedOutputAmount: BigNumber;
}

export type SpeedUp = V2SpeedUp; // @todo Extend with V2SpeedUp | V3SpeedUp.

export interface SlowFillRequest extends V3RelayData {}
export interface SlowFillRequestWithBlock extends SlowFillRequest, SortableEvent {}

export interface V2SlowFillLeaf {
  relayData: RelayData;
  payoutAdjustmentPct: string;
}

export interface V3SlowFillLeaf {
  relayData: V3RelayData;
  chainId: number;
  updatedOutputAmount: BigNumber;
}

// @todo: Extend with V2SlowFillLeaf | V3SlowFillLeaf.
export type SlowFillLeaf = V2SlowFillLeaf;

export interface RootBundleRelay {
  rootBundleId: number;
  relayerRefundRoot: string;
  slowRelayRoot: string;
}

export interface RootBundleRelayWithBlock extends RootBundleRelay, SortableEvent {}

export interface RelayerRefundExecution {
  amountToReturn: BigNumber;
  chainId: number;
  refundAmounts: BigNumber[];
  rootBundleId: number;
  leafId: number;
  l2TokenAddress: string;
  refundAddresses: string[];
}

export interface RelayerRefundExecutionWithBlock extends RelayerRefundExecution, SortableEvent {}

export interface UnfilledDeposit {
  deposit: Deposit;
  unfilledAmount: BigNumber;
  hasFirstPartialFill?: boolean;
  relayerBalancingFee?: BigNumber;
}

export interface UnfilledDepositsForOriginChain {
  [originChainIdPlusDepositId: string]: UnfilledDeposit[];
}

export interface Refund {
  [refundAddress: string]: BigNumber;
}
export type FillsToRefund = {
  [repaymentChainId: number]: {
    [l2TokenAddress: string]: {
      fills: Fill[];
      refunds?: Refund;
      totalRefundAmount: BigNumber;
      realizedLpFees: BigNumber;
    };
  };
};

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
