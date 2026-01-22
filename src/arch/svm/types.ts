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
 */
export type SolanaTransaction = TransactionMessage &
  TransactionMessageWithBlockhashLifetime &
  TransactionMessageWithFeePayer;

export type EventData =
  | SvmSpokeClient.BridgedToHubPool
  | SvmSpokeClient.TokensBridged
  | SvmSpokeClient.ExecutedRelayerRefundRoot
  | SvmSpokeClient.RelayedRootBundle
  | SvmSpokeClient.PausedDeposits
  | SvmSpokeClient.PausedFills
  | SvmSpokeClient.SetXDomainAdmin
  | SvmSpokeClient.FilledRelay
  | SvmSpokeClient.FundsDeposited
  | SvmSpokeClient.EmergencyDeletedRootBundle
  | SvmSpokeClient.RequestedSlowFill
  | SvmSpokeClient.ClaimedRelayerRefund
  | SvmSpokeClient.TransferredOwnership;

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

export type EventWithData = {
  confirmationStatus: string | null;
  blockTime: UnixTimestamp | null;
  signature: Signature;
  slot: bigint;
  name: string;
  data: unknown;
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
