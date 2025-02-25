import { Signature, Address, UnixTimestamp } from "@solana/web3-v2.js";

export type BridgedToHubPoolEvent = {
  amount: bigint;
  mint: Address;
};

export type TokensBridgedEvent = {
  amount_to_return: bigint;
  chain_id: bigint;
  leaf_id: number;
  l2_token_address: Address;
  caller: Address;
};

export type ExecutedRelayerRefundRootEvent = {
  amount_to_return: bigint;
  chain_id: bigint;
  refund_amounts: bigint[];
  root_bundle_id: number;
  leaf_id: number;
  l2_token_address: Address;
  refund_addresses: Address[];
  deferred_refunds: boolean;
  caller: Address;
};

export type RelayedRootBundleEvent = {
  root_bundle_id: number;
  relayer_refund_root: Array<number>;
  slow_relay_root: Array<number>;
};

export type PausedDepositsEvent = {
  is_paused: boolean;
};

export type PausedFillsEvent = {
  is_paused: boolean;
};

export type SetXDomainAdminEvent = {
  new_admin: Address;
};

export type EnabledDepositRouteEvent = {
  origin_token: Address;
  destination_chain_id: bigint;
  enabled: boolean;
};

export type FillType = "FastFill" | "ReplacedSlowFill" | "SlowFill";

export type FilledRelayEvent = {
  input_token: Address;
  output_token: Address;
  input_amount: bigint;
  output_amount: bigint;
  repayment_chain_id: bigint;
  origin_chain_id: bigint;
  deposit_id: Array<number>;
  fill_deadline: number;
  exclusivity_deadline: number;
  exclusive_relayer: Address;
  relayer: Address;
  depositor: Address;
  recipient: Address;
  message_hash: string;
  relay_execution_info: {
    updated_recipient: Address;
    updated_message_hash: string;
    updated_output_amount: bigint;
    fill_type: Record<FillType, {}>;
  };
};

export type FundsDepositedEvent = {
  input_token: Address;
  output_token: Address;
  input_amount: bigint;
  output_amount: bigint;
  destination_chain_id: bigint;
  deposit_id: Array<number>;
  quote_timestamp: number;
  fill_deadline: number;
  exclusivity_deadline: number;
  depositor: Address;
  recipient: Address;
  exclusive_relayer: Address;
  message: Buffer;
};

export type EmergencyDeletedRootBundleEvent = {
  root_bundle_id: number;
};

export type RequestedSlowFillEvent = {
  input_token: Address;
  output_token: Address;
  input_amount: bigint;
  output_amount: bigint;
  origin_chain_id: bigint;
  deposit_id: Array<number>;
  fill_deadline: number;
  exclusivity_deadline: number;
  exclusive_relayer: Address;
  depositor: Address;
  recipient: Address;
  message_hash: string;
};

export type ClaimedRelayerRefundEvent = {
  l2_token_address: Address;
  claim_amount: bigint;
  refund_address: Address;
};

export type EventData =
  | BridgedToHubPoolEvent
  | TokensBridgedEvent
  | ExecutedRelayerRefundRootEvent
  | RelayedRootBundleEvent
  | PausedDepositsEvent
  | PausedFillsEvent
  | SetXDomainAdminEvent
  | EnabledDepositRouteEvent
  | FilledRelayEvent
  | FundsDepositedEvent
  | EmergencyDeletedRootBundleEvent
  | RequestedSlowFillEvent
  | ClaimedRelayerRefundEvent;

export enum SVMEventNames {
  FilledRelay = "FilledRelay",
  FundsDeposited = "FundsDeposited",
  EnabledDepositRoute = "EnabledDepositRoute",
  RelayedRootBundle = "RelayedRootBundle",
  ExecutedRelayerRefundRoot = "ExecutedRelayerRefundRoot",
  BridgedToHubPool = "BridgedToHubPool",
  PausedDeposits = "PausedDeposits",
  PausedFills = "PausedFills",
  SetXDomainAdmin = "SetXDomainAdmin",
  EmergencyDeletedRootBundle = "EmergencyDeletedRootBundle",
  RequestedSlowFill = "RequestedSlowFill",
  ClaimedRelayerRefund = "ClaimedRelayerRefund",
  TokensBridged = "TokensBridged",
}

export type EventName = keyof typeof SVMEventNames;

export type EventWithData<T extends EventData> = {
  confirmationStatus: string;
  blockTime: UnixTimestamp;
  signature: Signature;
  slot: bigint;
  name: string;
  data: T;
  program: Address;
};
