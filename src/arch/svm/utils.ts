import { BN, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import web3, { address, isAddress, RpcTransport } from "@solana/kit";
import { SvmAddress } from "../../utils";
import { EventName, EventData, SVMEventNames } from "./types";

/**
 * Helper to determine if the current RPC network is devnet.
 */
export async function isDevnet(rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>): Promise<boolean> {
  const genesisHash = await rpc.getGenesisHash().send();
  return genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
}

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
      return address(eventData.toString());
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
 * Decodes a raw event according to a supplied IDL.
 */
export function decodeEvent(idl: Idl, rawEvent: string): { data: EventData; name: EventName } {
  const event = new BorshEventCoder(idl).decode(rawEvent);
  if (!event) throw new Error(`Malformed rawEvent for IDL ${idl.address}: ${rawEvent}`);
  return {
    name: getEventName(event.name),
    data: parseEventData(event.data),
  };
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
export function getEventName(rawName: string): EventName {
  if (Object.values(SVMEventNames).some((name) => rawName.includes(name))) return rawName as EventName;
  throw new Error(`Unknown event name: ${rawName}`);
}

/**
 * Unwraps an event data object and converts Address types to strings.
 */
export function unwrapEventData<T extends EventData>(eventData: T, uint8ArrayKeysAsBigInt = ["depositId"]): unknown {
  if (!eventData) return eventData;

  if (Array.isArray(eventData)) {
    return eventData.map((item) => unwrapEventData(item as EventData, uint8ArrayKeysAsBigInt));
  }

  if (typeof eventData === "string") {
    // Check if it's an Address instance
    if (isAddress(eventData)) {
      return SvmAddress.from(eventData).toBytes32();
    }
  }

  if (eventData instanceof Uint8Array) {
    const hex = "0x" + Buffer.from(eventData).toString("hex");
    return uint8ArrayKeysAsBigInt.includes("depositId") ? BigInt(hex) : hex;
  }

  if (typeof eventData === "object") {
    // Process regular objects
    const result = Object.fromEntries(
      Object.entries(eventData).map(([key, value]) => {
        const processedValue =
          value instanceof Uint8Array
            ? uint8ArrayKeysAsBigInt.includes(key)
              ? BigInt("0x" + Buffer.from(value).toString("hex"))
              : "0x" + Buffer.from(value).toString("hex")
            : unwrapEventData(value as EventData, uint8ArrayKeysAsBigInt);
        return [key, processedValue];
      })
    );
    return result;
  }

  return eventData;
}
