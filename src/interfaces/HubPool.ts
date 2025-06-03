import { Address, BigNumber, EvmAddress } from "../utils";
import { SortableEvent } from "./Common";

export interface PoolRebalanceLeaf {
  chainId: number;
  groupIndex: number;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  leafId: number;
  l1Tokens: EvmAddress[];
}

export interface RelayerRefundLeaf {
  amountToReturn: BigNumber;
  chainId: number;
  refundAmounts: BigNumber[];
  leafId: number;
  l2TokenAddress: Address;
  refundAddresses: Address[];
}

export interface ProposedRootBundle extends SortableEvent {
  challengePeriodEndTimestamp: number;
  poolRebalanceLeafCount: number;
  bundleEvaluationBlockNumbers: BigNumber[];
  poolRebalanceRoot: string;
  relayerRefundRoot: string;
  slowRelayRoot: string;
  proposer: string;
}

export type RealizedLpFee = {
  quoteBlock: number;
  realizedLpFeePct: BigNumber;
};

export type ProposedRootBundleStringified = Omit<ProposedRootBundle, "bundleEvaluationBlockNumbers"> & {
  bundleEvaluationBlockNumbers: string[];
};

export interface CancelledRootBundle extends SortableEvent {
  disputer: string;
  requestTime: number;
}

export interface DisputedRootBundle extends SortableEvent {
  disputer: string;
  requestTime: number;
}

export interface ExecutedRootBundle extends SortableEvent {
  chainId: number;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  leafId: number;
  l1Tokens: EvmAddress[];
  proof: string[];
}

export type ExecutedRootBundleStringified = Omit<
  ExecutedRootBundle,
  "bundleLpFees" | "netSendAmounts" | "runningBalances"
> & {
  bundleLpFees: string[];
  netSendAmounts: string[];
  runningBalances: string[];
};

export type TokenRunningBalance = {
  runningBalance: BigNumber;
};

export interface RelayerRefundLeafWithGroup extends RelayerRefundLeaf {
  groupIndex: number;
}

export interface L1TokenInfo {
  address: EvmAddress;
  symbol: string;
  decimals: number;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface LpToken {
  lastLpFeeUpdate: number;
  liquidReserves: BigNumber;
}

// TODO: I think I don't change string -> Address in the Events. I change right after the event is read
export interface CrossChainContractsSet extends SortableEvent {
  l2ChainId: number;
  spokePool: Address;
}

// TODO: I think I don't change string -> Address in the Events. I change right after the event is read
export interface DestinationTokenWithBlock extends SortableEvent {
  l2Token: Address;
  l1Token: EvmAddress;
}

// TODO: I think I don't change string -> Address in the Events. I change right after the event is read
export interface SetPoolRebalanceRoot extends SortableEvent {
  destinationChainId: number;
  l1Token: EvmAddress;
  destinationToken: Address;
}

export interface PendingRootBundle {
  poolRebalanceRoot: string;
  relayerRefundRoot: string;
  slowRelayRoot: string;
  proposer: EvmAddress;
  unclaimedPoolRebalanceLeafCount: number;
  challengePeriodEndTimestamp: number;
  bundleEvaluationBlockNumbers: number[];
  proposalBlockNumber?: number;
}
