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
} from "@solana/kit";
import { interfaces } from "../..";

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

// CCTP types

type CommonMessageData = {
  cctpVersion: number;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string;
  messageBytes: string;
  nonce: number;
  nonceHash: string;
};

export type DepositForBurnMessageData = CommonMessageData & {
  amount: string;
  mintRecipient: string;
  burnToken: string;
};
export type CommonMessageEvent = CommonMessageData & { log: interfaces.Log };
export type DepositForBurnMessageEvent = DepositForBurnMessageData & { log: interfaces.Log };
export type CCTPMessageStatus = "finalized" | "ready" | "pending";
export type CCTPMessageEvent = CommonMessageEvent | DepositForBurnMessageEvent;
export type AttestedCCTPMessage = CCTPMessageEvent & { status: CCTPMessageStatus; attestation: string };
