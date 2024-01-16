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
  newRelayerFeePct?: BigNumber;
  updatedMessage?: string;
  realizedLpFeePct?: BigNumber; // appended after initialization (not part of Deposit event).
}

export interface v2Deposit extends DepositCommon {
  originToken: string;
  amount: BigNumber;
  relayerFeePct: BigNumber;
  realizedLpFeePct?: BigNumber; // appended after initialization (not part of Deposit event).
  destinationToken: string; // appended after initialization (not part of Deposit event).
  newRelayerFeePct?: BigNumber; // appended after initialization, if deposit was speedup (not part of Deposit event).
}

export interface v2DepositWithBlock extends v2Deposit, SortableEvent {
  blockTimestamp: number;
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
  blockTimestamp: number;
  quoteBlockNumber: number;
}

export type Deposit = v2Deposit; // @todo: Extend with v2Deposit | v3Deposit.
export type DepositWithBlock = v2DepositWithBlock; // @todo Extend with v2DepositWithBlock | v3DepositWithBlock.

export type v2DepositWithBlockStringified = Omit<
  v2DepositWithBlock,
  "amount" | "relayerFeePct" | "realizedLpFeePct" | "newRelayerFeePct"
> & {
  amount: string;
  relayerFeePct: string;
  realizedLpFeePct?: string;
  newRelayerFeePct?: string;
};

export type v3DepositWithBlockStringified = Omit<
  v3DepositWithBlock,
  "inputAmount" | "outputAmount" | "realizedLpFeePct" | "newRelayerFeePct"
> & {
  amount: string;
  relayerFeePct: string;
  realizedLpFeePct?: string;
  newRelayerFeePct?: string;
};

// @todo Extend with v3DepositWithBlockStringified.
export type DepositWithBlockStringified = v2DepositWithBlockStringified;

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
  RequestedSlowFil,
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

export type RelayerRefundExecutionInfoStringified = Omit<
  RelayExecutionInfo,
  "relayerFeePct" | "payoutAdjustmentPct"
> & {
  relayerFeePct: string;
  payoutAdjustmentPct: string;
};

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

export interface v2FillWithBlock extends v2Fill, SortableEvent {
  blockTimestamp: number;
}

export interface v3FillWithBlock extends v3Fill, SortableEvent {
  blockTimestamp: number;
}

export type Fill = v2Fill; // @todo: Extend with v2Fill | v3Fill.
export type FillWithBlock = v2FillWithBlock; // @todo Extend with v2FillWithBlock | v3FillWithBlock.

export type v2FillWithBlockStringified = Omit<
  v2FillWithBlock,
  "amount" | "relayerFeePct" | "totalFilledAmount" | "fillAmount" | "realizedLpFeePct" | "updatableRelayData"
> & {
  amount: string;
  totalFilledAmount: string;
  fillAmount: string;
  relayerFeePct: string;
  realizedLpFeePct: string;
  updatableRelayData: RelayerRefundExecutionInfoStringified;
};

export type v3FillWithBlockStringified = Omit<
  v3FillWithBlock,
  "inoutAmount" | "outputAmount" | "updatableRelayData"
> & {
  inputAmount: string;
  outputAmount: string;
  updatableRelayData: RelayerRefundExecutionInfoStringified;
};

// @todo: Extend with v2FillWithBlockStringified | v3FillWithBlockStringified.
export type FillWithBlockStringified = v2FillWithBlockStringified;

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

export type SpeedUp = v2SpeedUp; // @todo Extend with v2SpeedUp | v3SpeedUp.

export type v2SpeedUpStringified = Omit<v2SpeedUp, "newRelayerFeePct"> & {
  newRelayerFeePct: string;
};

export type v3SpeedUpStringified = Omit<v3SpeedUp, "updatedOutputAmount"> & {
  updatedOutputAmount: string;
};

// @todo: Extend with v2SpeedUpStringified | v3SpeedUpStringified.
export type SpeedUpStringified = v2SpeedUpStringified;

export interface SlowFillRequest {
  depositId: number;
  originChainId: number;
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
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
