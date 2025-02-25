import { SvmSpokeClient } from "@across-protocol/contracts";
import { BN } from "@coral-xyz/anchor";
import web3 from "@solana/web3-v2.js";
import { EventData, EventName, SVMEventNames } from "../types";

/**
 * Parses event data from a transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Convert each key from snake_case to camelCase and process the value recursively.
    return Object.fromEntries(
      Object.entries(eventData).map(([key, value]) => [snakeToCamel(key), parseEventData(value)])
    );
  }

  return eventData;
}

/**
 * Converts a snake_case string to camelCase.
 */
function snakeToCamel(s: string): string {
  return s.replace(/(_\w)/g, (match) => match[1].toUpperCase());
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapEventData(eventData: any, name: EventName): EventData {
  switch (name) {
    case "FilledRelay":
      return eventData as SvmSpokeClient.FilledRelay;
    case "FundsDeposited":
      return eventData as SvmSpokeClient.FundsDeposited;
    case "BridgedToHubPool":
      return eventData as SvmSpokeClient.BridgedToHubPool;
    case "TokensBridged":
      return eventData as SvmSpokeClient.TokensBridged;
    case "ExecutedRelayerRefundRoot":
      return eventData as SvmSpokeClient.ExecutedRelayerRefundRoot;
    case "RelayedRootBundle":
      return eventData as SvmSpokeClient.RelayedRootBundle;
    case "PausedDeposits":
      return eventData as SvmSpokeClient.PausedDeposits;
    case "PausedFills":
      return eventData as SvmSpokeClient.PausedFills;
    case "SetXDomainAdmin":
      return eventData as SvmSpokeClient.SetXDomainAdmin;
    case "EnabledDepositRoute":
      return eventData as SvmSpokeClient.EnabledDepositRoute;
    case "EmergencyDeletedRootBundle":
      return eventData as SvmSpokeClient.EmergencyDeletedRootBundle;
    case "RequestedSlowFill":
      return eventData as SvmSpokeClient.RequestedSlowFill;
    case "ClaimedRelayerRefund":
      return eventData as SvmSpokeClient.ClaimedRelayerRefund;
    case "TransferredOwnership":
      return eventData as SvmSpokeClient.TransferredOwnership;
    default:
      throw new Error(`Unknown event name: ${name}`);
  }
}
