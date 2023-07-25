import { BigNumber } from "ethers";
import { SortableEvent } from "./Common";
import { FundsDepositedEvent } from "../typechain";

export type { FundsDepositedEvent } from "../typechain";

export interface Deposit {
  depositId: number;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: BigNumber;
  originChainId: number; // appended from chainID in the client.
  destinationChainId: number;
  relayerFeePct: BigNumber;
  quoteTimestamp: number;
  realizedLpFeePct?: BigNumber; // appended after initialization (not part of Deposit event).
  destinationToken: string; // appended after initialization (not part of Deposit event).
  message: string;
  speedUpSignature?: string | undefined; // appended after initialization, if deposit was speedup (not part of Deposit event).
  newRelayerFeePct?: BigNumber; // appended after initialization, if deposit was speedup (not part of Deposit event).
  updatedRecipient?: string;
  updatedMessage?: string;
}

export interface DepositWithBlock extends Deposit, SortableEvent {
  quoteBlockNumber: number;
}

export type DepositWithBlockStringified = Omit<
  DepositWithBlock,
  "amount" | "relayerFeePct" | "realizedLpFeePct" | "newRelayerFeePct"
> & {
  amount: string;
  relayerFeePct: string;
  realizedLpFeePct?: string;
  newRelayerFeePct?: string;
};

export interface RelayExecutionInfo {
  recipient: string;
  message: string;
  relayerFeePct: BigNumber;
  isSlowRelay: boolean;
  payoutAdjustmentPct: BigNumber;
}
export type RelayerRefundExecutionInfoStringified = Omit<
  RelayExecutionInfo,
  "relayerFeePct" | "payoutAdjustmentPct"
> & {
  relayerFeePct: string;
  payoutAdjustmentPct: string;
};
export interface Fill {
  amount: BigNumber;
  totalFilledAmount: BigNumber;
  fillAmount: BigNumber;
  repaymentChainId: number;
  originChainId: number;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  depositId: number;
  destinationToken: string;
  relayer: string;
  depositor: string;
  recipient: string;
  message: string;
  destinationChainId: number;
  updatableRelayData: RelayExecutionInfo;
}

export interface FillWithBlock extends Fill, SortableEvent {}

export type FillWithBlockStringified = Omit<
  FillWithBlock,
  "amount" | "relayerFeePct" | "totalFilledAmount" | "fillAmount" | "realizedLpFeePct" | "updatableRelayData"
> & {
  amount: string;
  totalFilledAmount: string;
  fillAmount: string;
  relayerFeePct: string;
  realizedLpFeePct: string;
  updatableRelayData: RelayerRefundExecutionInfoStringified;
};

export interface SpeedUp {
  depositor: string;
  depositorSignature: string;
  newRelayerFeePct: BigNumber;
  depositId: number;
  originChainId: number;
  updatedRecipient: string;
  updatedMessage: string;
}

export type SpeedUpStringified = Omit<SpeedUp, "newRelayerFeePct"> & {
  newRelayerFeePct: string;
};

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

export interface SlowFillLeaf {
  relayData: RelayData;
  payoutAdjustmentPct: string;
}

export interface RefundRequest {
  relayer: string;
  refundToken: string;
  amount: BigNumber;
  originChainId: number;
  destinationChainId: number;
  repaymentChainId: number;
  realizedLpFeePct: BigNumber;
  depositId: number;
  fillBlock: BigNumber;
  previousIdenticalRequests: BigNumber;
}

export interface RefundRequestWithBlock extends RefundRequest, SortableEvent {}

export type RefundRequestWithBlockStringified = Omit<
  RefundRequestWithBlock,
  "amount" | "realizedLpFeePct" | "previousIdenticalRequests" | "fillBlock" | "previousIdenticalRequests"
> & {
  amount: string;
  realizedLpFeePct: string;
  previousIdenticalRequests: string;
  fillBlock: string;
};

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
  caller: string;
}

export interface RelayerRefundExecutionWithBlock extends RelayerRefundExecution, SortableEvent {}

export type RelayerRefundExecutionWithBlockStringified = Omit<
  RelayerRefundExecutionWithBlock,
  "amountToReturn" | "refundAmounts"
> & {
  amountToReturn: string;
  refundAmounts: string[];
};

// Used in pool by spokePool to execute a slow relay.
export interface RelayData {
  depositor: string;
  recipient: string;
  destinationToken: string;
  amount: BigNumber;
  realizedLpFeePct: BigNumber;
  relayerFeePct: BigNumber;
  depositId: number;
  originChainId: number;
  destinationChainId: number;
  message: string;
}

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
  caller: string;
}

export type TokensBridgedStringified = Omit<TokensBridged, "amountToReturn"> & {
  amountToReturn: string;
};

export type FundsDepositedEventStringified = Omit<
  FundsDepositedEvent,
  "amount" | "originChainId" | "destinationChainId" | "relayerFeePct"
> & {
  amount: string;
  originChainId: string;
  destinationChainId: string;
  relayerFeePct: string;
};
