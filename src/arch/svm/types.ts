import { Signature, Address, UnixTimestamp, Rpc, SolanaRpcApiFromTransport, RpcTransport } from "@solana/kit";
import { SvmSpokeClient } from "@across-protocol/contracts";

export type EventData =
  | SvmSpokeClient.BridgedToHubPool
  | SvmSpokeClient.TokensBridged
  | SvmSpokeClient.ExecutedRelayerRefundRoot
  | SvmSpokeClient.RelayedRootBundle
  | SvmSpokeClient.PausedDeposits
  | SvmSpokeClient.PausedFills
  | SvmSpokeClient.SetXDomainAdmin
  | SvmSpokeClient.EnabledDepositRoute
  | SvmSpokeClient.FilledRelay
  | SvmSpokeClient.FundsDeposited
  | SvmSpokeClient.EmergencyDeletedRootBundle
  | SvmSpokeClient.RequestedSlowFill
  | SvmSpokeClient.ClaimedRelayerRefund
  | SvmSpokeClient.TransferredOwnership;

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
