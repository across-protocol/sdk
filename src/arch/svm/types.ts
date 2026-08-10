import { SvmSpokeClient } from "@across-protocol/contracts";
import {
  Address,
  Rpc,
  RpcSubscriptions,
  RpcTransport,
  Signature,
  SignatureNotificationsApi,
  SlotNotificationsApi,
  SolanaRpcApiFromTransport,
  UnixTimestamp,
  type Blockhash,
  type TransactionMessage,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayer,
} from "@solana/kit";

/**
 * A Solana transaction message ready to be signed and sent.
 * Includes fee payer and blockhash lifetime information.
 * Always uses version 0 (not legacy format).
 */
export type SolanaTransaction = Extract<TransactionMessage, { version: 0 }> &
  TransactionMessageWithBlockhashLifetime &
  TransactionMessageWithFeePayer;

// Maps each SvmSpoke event name to the event data type generated from the program.
export interface EventNameToData {
  FilledRelay: SvmSpokeClient.FilledRelay;
  FundsDeposited: SvmSpokeClient.FundsDeposited;
  RelayedRootBundle: SvmSpokeClient.RelayedRootBundle;
  ExecutedRelayerRefundRoot: SvmSpokeClient.ExecutedRelayerRefundRoot;
  BridgedToHubPool: SvmSpokeClient.BridgedToHubPool;
  PausedDeposits: SvmSpokeClient.PausedDeposits;
  PausedFills: SvmSpokeClient.PausedFills;
  SetXDomainAdmin: SvmSpokeClient.SetXDomainAdmin;
  EmergencyDeletedRootBundle: SvmSpokeClient.EmergencyDeletedRootBundle;
  RequestedSlowFill: SvmSpokeClient.RequestedSlowFill;
  ClaimedRelayerRefund: SvmSpokeClient.ClaimedRelayerRefund;
  TokensBridged: SvmSpokeClient.TokensBridged;
  TransferredOwnership: SvmSpokeClient.TransferredOwnership;
}

export enum SVMEventNames {
  FilledRelay = "FilledRelay",
  FundsDeposited = "FundsDeposited",
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
  TransferredOwnership = "TransferredOwnership",
}

export type EventName = keyof typeof SVMEventNames;

export type EventData = EventNameToData[EventName];

// A decoded SvmSpoke event. The name discriminates the data type: checking `event.name` narrows `event.data`
// to the corresponding generated event type. The narrow form is defined via Extract so that narrowing
// predicates over a generic event name remain provably assignable to the base union, and the name is passed
// through a template literal so that SVMEventNames enum members (which are nominal) resolve to their string
// literals and may be used interchangeably with them.
type AnyDecodedEvent = { [N in EventName]: { name: N; data: EventNameToData[N] } }[EventName];
export type DecodedEvent<T extends EventName = EventName> = Extract<AnyDecodedEvent, { name: `${T}` }>;

export type EventWithData<T extends EventName = EventName> = DecodedEvent<T> & {
  confirmationStatus: string | null;
  blockTime: UnixTimestamp | null;
  signature: Signature;
  slot: bigint;
  program: Address;
};

export type SVMProvider = Rpc<SolanaRpcApiFromTransport<RpcTransport>>;

// Typed aggregate of JSON‑RPC and subscription clients.
export type RpcClient = {
  rpc: SVMProvider;
  rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
};

export type AttestedCCTPMessage = {
  nonce: number;
  sourceDomain: number;
  messageBytes: string;
  attestation: string;
  type: "transfer" | "message";
};

export type LatestBlockhash = {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
};
