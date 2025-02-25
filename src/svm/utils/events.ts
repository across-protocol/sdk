import { BN } from "@coral-xyz/anchor";
import web3 from "@solana/web3-v2.js";
import {
  BridgedToHubPoolEvent,
  ClaimedRelayerRefundEvent,
  EmergencyDeletedRootBundleEvent,
  EnabledDepositRouteEvent,
  EventData,
  EventName,
  ExecutedRelayerRefundRootEvent,
  FilledRelayEvent,
  FundsDepositedEvent,
  PausedDepositsEvent,
  PausedFillsEvent,
  RelayedRootBundleEvent,
  RequestedSlowFillEvent,
  SetXDomainAdminEvent,
  SVMEventNames,
  TokensBridgedEvent,
  TransferredOwnershipEvent,
} from "../types";

/**
 * Parses event data from a transaction.
 */
export function parseEventData(eventData: any): any {
  if (!eventData) return eventData;

  if (Array.isArray(eventData)) {
    return eventData.map(parseEventData);
  }

  if (typeof eventData === "object") {
    if (eventData.constructor.name === "PublicKey") {
      return web3.address(eventData.toString());
    }
    if (BN.isBN(eventData)) {
      return BigInt(eventData.toString());
    }

    return Object.fromEntries(Object.entries(eventData).map(([key, value]) => [key, parseEventData(value)]));
  }

  return eventData;
}

/**
 * Gets the event name from a raw name.
 */
export function getEventName(rawName?: string): EventName {
  if (!rawName) throw new Error("Raw name is undefined");
  if (Object.values(SVMEventNames).some((name) => rawName.includes(name))) return rawName as EventName;
  throw new Error(`Unknown event name: ${rawName}`);
}

/**
 * Maps event data to an event type.
 */
export function mapEventData(eventData: any, name: EventName): EventData {
  switch (name) {
    case "FilledRelay":
      return eventData as FilledRelayEvent;
    case "FundsDeposited":
      return eventData as FundsDepositedEvent;
    case "BridgedToHubPool":
      return eventData as BridgedToHubPoolEvent;
    case "TokensBridged":
      return eventData as TokensBridgedEvent;
    case "ExecutedRelayerRefundRoot":
      return eventData as ExecutedRelayerRefundRootEvent;
    case "RelayedRootBundle":
      return eventData as RelayedRootBundleEvent;
    case "PausedDeposits":
      return eventData as PausedDepositsEvent;
    case "PausedFills":
      return eventData as PausedFillsEvent;
    case "SetXDomainAdmin":
      return eventData as SetXDomainAdminEvent;
    case "EnabledDepositRoute":
      return eventData as EnabledDepositRouteEvent;
    case "EmergencyDeletedRootBundle":
      return eventData as EmergencyDeletedRootBundleEvent;
    case "RequestedSlowFill":
      return eventData as RequestedSlowFillEvent;
    case "ClaimedRelayerRefund":
      return eventData as ClaimedRelayerRefundEvent;
    case "TransferredOwnership":
      return eventData as TransferredOwnershipEvent;
    default:
      throw new Error(`Unknown event name: ${name}`);
  }
}
