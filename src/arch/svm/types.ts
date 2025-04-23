import { Signature, Address, UnixTimestamp } from "@solana/kit";

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
