import bs58 from "bs58";
import { ethers } from "ethers";
import { BN, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import {
  Address,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getU32Encoder,
  isAddress,
  type TransactionSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { FillType, RelayData } from "../../interfaces";
import { BigNumber, getRelayDataHash, isUint8Array, Address as SdkAddress } from "../../utils";
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
 * Small utility to convert an Address to a Solana Kit branded type.
 */
export function toAddress(address: SdkAddress): Address<string> {
  return address.toBase58() as Address<string>;
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

  if (Buffer.isBuffer(eventData)) {
    return new Uint8Array(eventData);
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
    const bigIntKeysAsNumber = ["originChainId", "destinationChainId", "repaymentChainId", "chainId"];
    if (currentKey && bigIntKeysAsNumber.includes(currentKey)) {
      return Number(data);
    }
    return BigNumber.from(data);
  }
  // Handle Uint8Array and byte arrays
  if (data instanceof Uint8Array || isUint8Array(data)) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as number[]);
    const hex = ethers.utils.hexlify(bytes);
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
    return ethers.utils.hexlify(bs58.decode(data));
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
 * Returns the PDA for the SVM Spoke's transfer liability account.
 * @param programId the address of the spoke pool.
 * @param originToken the address of the corresponding token.
 */
export async function getTransferLiabilityPda(programId: Address, originToken: Address): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["transfer_liability", addressEncoder.encode(originToken)],
  });
  return pda;
}

/**
 * Returns the PDA for the SVM Spoke's root bundle account.
 * @param programId the address of the spoke pool.
 * @param statePda the spoke pool's state pda.
 * @param rootBundleId the associated root bundle ID.
 */
export async function getRootBundlePda(programId: Address, state: Address, rootBundleId: number): Promise<Address> {
  const intEncoder = getU32Encoder();
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["root_bundle", addressEncoder.encode(state), intEncoder.encode(rootBundleId)],
  });
  return pda;
}

/**
 * Returns the PDA for the SVM Spoke's instruction params account.
 * @param programId the address of the spoke pool.
 * @param signer the signer of the authenticated call.
 */
export async function getInstructionParamsPda(programId: Address, signer: Address): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["instruction_params", addressEncoder.encode(signer)],
  });
  return pda;
}

/**
 * Returns the PDA for the Event Authority.
 * @returns The PDA for the Event Authority.
 */
export async function getEventAuthority(programId: Address): Promise<Address> {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["__event_authority"],
  });
  return eventAuthority;
}

/**
 * Returns a random SVM address.
 */
export function getRandomSvmAddress() {
  const bytes = ethers.utils.randomBytes(32);
  const base58Address = bs58.encode(bytes);
  return address(base58Address);
}

/**
 * Creates a default v0 transaction skeleton.
 * @param rpcClient - The Solana client.
 * @param signer - The signer of the transaction.
 * @returns The default transaction.
 */
export const createDefaultTransaction = async (rpcClient: SVMProvider, signer: TransactionSigner) => {
  const { value: latestBlockhash } = await rpcClient.getLatestBlockhash().send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx)
  );
};

/**
 * Convert a bigint (0 ≤ n < 2^256) to a 32-byte Uint8Array (big-endian).
 */
export function bigintToU8a32(n: bigint): Uint8Array {
  if (n < BigInt(0) || n > ethers.constants.MaxUint256.toBigInt()) {
    throw new RangeError("Value must fit in 256 bits");
  }
  const hexPadded = ethers.utils.hexZeroPad("0x" + n.toString(16), 32);
  return ethers.utils.arrayify(hexPadded);
}

export const bigToU8a32 = (bn: bigint | BigNumber) =>
  bigintToU8a32(typeof bn === "bigint" ? bn : BigInt(bn.toString()));

export const numberToU8a32 = (n: number) => bigintToU8a32(BigInt(n));
