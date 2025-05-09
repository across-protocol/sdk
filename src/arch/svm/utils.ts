import { SvmSpokeClient } from "@across-protocol/contracts";
import { hashNonEmptyMessage } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { BN, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import {
  Address,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  isAddress,
  type TransactionSigner,
} from "@solana/kit";
import { ethers } from "ethers";
import { FillType, RelayData } from "../../interfaces";
import { BigNumber, SvmAddress, getRelayDataHash, isUint8Array } from "../../utils";
import { EventName, SVMEventNames, SVMProvider } from "./types";

/**
 * Basic void TransactionSigner type
 */
export const SolanaVoidSigner: (simulationAddress: string) => TransactionSigner<string> = (
  simulationAddress: string
) => {
  return {
    address: address(simulationAddress),
    signAndSendTransactions: async () => {
      return await Promise.resolve([]);
    },
  };
};

/**
 * Helper to determine if the current RPC network is devnet.
 */
export async function isDevnet(rpc: SVMProvider): Promise<boolean> {
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
export function decodeEvent(idl: Idl, rawEvent: string): { data: unknown; name: string } {
  const event = new BorshEventCoder(idl).decode(rawEvent);
  if (!event) throw new Error(`Malformed rawEvent for IDL ${idl.address}: ${rawEvent}`);
  return {
    name: event.name,
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
 * Unwraps any data structure and converts Address types to strings and Uint8Array to hex or BigInt.
 * Recursively processes nested objects and arrays.
 */
export function unwrapEventData(
  data: unknown,
  uint8ArrayKeysAsBigInt: string[] = ["depositId"],
  currentKey?: string
): unknown {
  // Handle null/undefined
  if (data == null) {
    return data;
  }
  // Handle BigInt
  if (typeof data === "bigint") {
    return BigNumber.from(data);
  }
  // Handle Uint8Array and byte arrays
  if (data instanceof Uint8Array || isUint8Array(data)) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as number[]);
    const hex = "0x" + Buffer.from(bytes).toString("hex");
    if (currentKey && uint8ArrayKeysAsBigInt.includes(currentKey)) {
      return BigNumber.from(hex);
    }
    return hex;
  }
  // Handle regular arrays (non-byte arrays)
  if (Array.isArray(data)) {
    return data.map((item) => unwrapEventData(item, uint8ArrayKeysAsBigInt));
  }
  // Handle strings (potential addresses)
  if (typeof data === "string" && isAddress(data)) {
    return SvmAddress.from(data).toBytes32();
  }
  // Handle objects
  if (typeof data === "object") {
    // Special case: if an object is in the context of the fillType key, then
    // parse out the fillType from the object
    if (currentKey === "fillType") {
      const fillType = Object.keys(data)[0];
      switch (fillType) {
        case "FastFill":
          return FillType.FastFill;
        case "ReplacedSlowFill":
          return FillType.ReplacedSlowFill;
        case "SlowFill":
          return FillType.SlowFill;
        default:
          throw new Error(`Unknown fill type: ${fillType}`);
      }
    }
    // Special case: if an object is empty, return 0x
    if (Object.keys(data).length === 0) {
      return "0x";
    }
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        unwrapEventData(value, uint8ArrayKeysAsBigInt, key),
      ])
    );
  }
  // Return primitives as is
  return data;
}

/**
 * Returns the PDA for the State account.
 * @param programId The SpokePool program ID.
 * @returns The PDA for the State account.
 */
export async function getStatePda(programId: Address): Promise<Address> {
  const intEncoder = getU64Encoder();
  const seed = intEncoder.encode(0);
  const [statePda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["state", seed],
  });
  return statePda;
}

/**
 * Calculates the relay hash from relay data and chain ID.
 */
export function _calculateRelayHashUint8Array(relayData: SvmSpokeClient.RelayDataArgs, chainId: bigint): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const uint64Encoder = getU64Encoder();
  const uint32Encoder = getU32Encoder();

  const contentToHash = Buffer.concat([
    Uint8Array.from(addressEncoder.encode(relayData.depositor)),
    Uint8Array.from(addressEncoder.encode(relayData.recipient)),
    Uint8Array.from(addressEncoder.encode(relayData.exclusiveRelayer)),
    Uint8Array.from(addressEncoder.encode(relayData.inputToken)),
    Uint8Array.from(addressEncoder.encode(relayData.outputToken)),
    Uint8Array.from(uint64Encoder.encode(relayData.inputAmount)),
    Uint8Array.from(uint64Encoder.encode(relayData.outputAmount)),
    Uint8Array.from(uint64Encoder.encode(relayData.originChainId)),
    Buffer.from(relayData.depositId),
    Uint8Array.from(uint32Encoder.encode(relayData.fillDeadline)),
    Uint8Array.from(uint32Encoder.encode(relayData.exclusivityDeadline)),
    hashNonEmptyMessage(Buffer.from(relayData.message)),
    Uint8Array.from(uint64Encoder.encode(chainId)),
  ]);

  const relayHash = ethers.utils.keccak256(contentToHash);
  const relayHashBuffer = Buffer.from(relayHash.slice(2), "hex");
  return new Uint8Array(relayHashBuffer);
}

export async function getFillStatusPda2(
  programId: Address,
  relayData: SvmSpokeClient.RelayDataArgs,
  destinationChainId: number
): Promise<Address> {
  const relayDataHash = _calculateRelayHashUint8Array(relayData, BigInt(destinationChainId));
  const [fillStatusPda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["fills", relayDataHash],
  });
  return fillStatusPda;
}

/**
 * Returns the fill status PDA for the given relay data.
 * @param programId The SpokePool program ID.
 * @param relayData The relay data to get the fill status PDA for.
 * @param destinationChainId The destination chain ID.
 * @returns The PDA for the fill status.
 */
export async function getFillStatusPda(
  programId: Address,
  relayData: RelayData,
  destinationChainId: number
): Promise<Address> {
  const relayDataHash = getRelayDataHash(relayData, destinationChainId);
  const uint8RelayDataHash = new Uint8Array(Buffer.from(relayDataHash.slice(2), "hex"));
  const [fillStatusPda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["fills", uint8RelayDataHash],
  });
  return fillStatusPda;
}

/**
 * Returns the PDA for a route account on SVM Spoke.
 * @param originToken The origin token address.
 * @param seed The seed for the route account.
 * @param routeChainId The route chain ID.
 * @returns The PDA for the route account.
 */
export async function getRoutePda(originToken: Address, seed: bigint, routeChainId: bigint): Promise<Address> {
  const intEncoder = getU64Encoder();
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: ["route", addressEncoder.encode(originToken), intEncoder.encode(seed), intEncoder.encode(routeChainId)],
  });
  return pda;
}

/**
 * Returns the PDA for the Event Authority.
 * @returns The PDA for the Event Authority.
 */
export const getEventAuthority = async () => {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: ["__event_authority"],
  });
  return eventAuthority;
};
