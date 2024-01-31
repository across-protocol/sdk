import { BigNumber } from "ethers";
import { SortableEvent } from "./Common";
import { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent } from "../typechain";
import { SpokePoolClient } from "../clients";

export type { FilledRelayEvent, FilledV3RelayEvent, FundsDepositedEvent, V3FundsDepositedEvent };

export interface DepositCommon {
  depositId: number;
  originChainId: number; // appended from chainID in the client.
  destinationChainId: number;
  depositor: string;
  recipient: string;
  quoteTimestamp: number;
  message: string;
  speedUpSignature?: string; // appended after initialization, if deposit was speedup (not part of Deposit event).
  updatedRecipient?: string;
  updatedMessage?: string;
  realizedLpFeePct: BigNumber; // appended after initialization (not part of Deposit event).
}

export interface v2Deposit extends DepositCommon {
  originToken: string;
  amount: BigNumber;
  relayerFeePct: BigNumber;
  destinationToken: string; // appended after initialization (not part of Deposit event).
  newRelayerFeePct?: BigNumber; // appended after initialization, if deposit was speedup (not part of Deposit event).
}

export interface v2DepositWithBlock extends v2Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export interface v3Deposit extends DepositCommon {
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  fillDeadline: number;
  relayer: string;
  exclusivityDeadline: number;
  updatedOutputAmount?: BigNumber; // appended after initialization if deposit was updated.
  relayerFeePct?: BigNumber;
}

export interface v3DepositWithBlock extends v3Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export type Deposit = v2Deposit | v3Deposit;
export type DepositWithBlock = v2DepositWithBlock | v3DepositWithBlock;

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

export interface v3RelayExecutionEventInfo extends RelayExecutionInfoCommon {
  outputAmount: BigNumber;
  fillType: FillType;
}

interface FillCommon {
  depositId: number;
  originChainId: number;
  destinationChainId: number;
  depositor: string;
  recipient: string;
  message: string;
  relayer: string;
  repaymentChainId: number;
  realizedLpFeePct: BigNumber; // appended after initialization (not part of Fill event).
}

export interface v2Fill extends FillCommon {
  destinationToken: string;
  amount: BigNumber;
  totalFilledAmount: BigNumber;
  fillAmount: BigNumber;
  relayerFeePct: BigNumber;
  updatableRelayData: RelayExecutionInfo;
}

export interface v3Fill extends FillCommon {
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusiveRelayer: string;
  updatableRelayData: v3RelayExecutionEventInfo;
}

export interface v2FillWithBlock extends v2Fill, SortableEvent {}
export interface v3FillWithBlock extends v3Fill, SortableEvent {}

export type Fill = v2Fill | v3Fill;
export type FillWithBlock = v2FillWithBlock | v3FillWithBlock;

export interface SpeedUpCommon {
  depositor: string;
  depositorSignature: string;
  depositId: number;
  originChainId: number;
  updatedRecipient: string;
  updatedMessage: string;
}

export interface v2SpeedUp extends SpeedUpCommon {
  newRelayerFeePct: BigNumber;
}

export interface v3SpeedUp extends SpeedUpCommon {
  updatedOutputAmount: BigNumber;
}

export type SpeedUp = v2SpeedUp | v3SpeedUp;

export interface SlowFillRequest {
  depositId: number;
  originChainId: number;
  destinationChainId: number;
  depositor: string;
  recipient: string;
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  message: string;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusiveRelayer: string;
}

export interface SlowFillRequestWithBlock extends SlowFillRequest, SortableEvent {}

export interface SlowFill {
  relayHash: string;
  amount: BigNumber;
  fillAmount: BigNumber;
  totalFilledAmount: BigNumber;
  originChainId: number;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  payoutAdjustmentPct: BigNumber;
  depositId: number;
  destinationToken: string;
  depositor: string;
  recipient: string;
  message: string;
}

export interface v2SlowFillLeaf {
  relayData: v2RelayData;
  realizedLpFeePct: BigNumber;
  payoutAdjustmentPct: string;
}

export interface v3SlowFillLeaf {
  relayData: v3RelayData;
  chainId: number;
  updatedOutputAmount: BigNumber;
}

export type SlowFillLeaf = v2SlowFillLeaf | v3SlowFillLeaf;

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

export interface RelayDataCommon {
  originChainId: number;
  depositor: string;
  recipient: string;
  depositId: number;
  message: string;
}

// Used in pool by spokePool to execute a slow relay.
export interface v2RelayData extends RelayDataCommon {
  destinationChainId: number;
  destinationToken: string;
  amount: BigNumber;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
}

export interface v3RelayData extends RelayDataCommon {
  inputToken: string;
  inputAmount: BigNumber;
  outputToken: string;
  outputAmount: BigNumber;
  fillDeadline: number;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
}

export type RelayData = v2RelayData | v3RelayData;

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
