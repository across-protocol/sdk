import { MessageTransmitterClient, SpokePool__factory, SvmSpokeClient } from "@across-protocol/contracts";
import { BN, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import {
  Address,
  IInstruction,
  KeyPairSigner,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Commitment,
  type TransactionSigner,
} from "@solana/kit";
import assert from "assert";
import bs58 from "bs58";
import { ethers } from "ethers";
import { FillType, RelayData } from "../../interfaces";
import { BigNumber, Address as SdkAddress, biMin, getRelayDataHash, isDefined, isUint8Array } from "../../utils";
import { getTimestampForSlot, getSlot } from "./SpokeUtils";
import { AttestedCCTPMessage, EventName, SVMEventNames, SVMProvider } from "./types";
import winston from "winston";

export { isSolanaError } from "@solana/kit";

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
 * For a given slot (or implicit head of chain), find the immediate preceding slot that contained a block.
 * @param provider SVM Provider instance.
 * @param opts An object containing a specific slot number, or a Solana commitment, defaulting to "confirmed".
 * @returns An object containing the slot number and the relevant timestamp for the block.
 */
export async function getNearestSlotTime(
  provider: SVMProvider,
  logger: winston.Logger,
  opts: { slot: bigint } | { commitment: Commitment } = { commitment: "confirmed" }
): Promise<{ slot: bigint; timestamp: number }> {
  let timestamp: number | undefined;
  let slot = "slot" in opts ? opts.slot : await getSlot(provider, opts.commitment, logger).send();

  do {
    timestamp = await getTimestampForSlot(provider, slot, logger);
  } while (!isDefined(timestamp) && --slot);
  assert(isDefined(timestamp), `Unable to resolve block time for SVM slot ${slot}`);

  return { slot, timestamp };
}

/**
 * Resolve the latest finalized slot, and then work backwards to find the nearest slot containing a block.
 * In most cases the first-resolved slot should also have a block. Avoid making arbitrary decisions about
 * how many slots to rotate through.
 */
export async function getLatestFinalizedSlotWithBlock(
  provider: SVMProvider,
  maxSlot: bigint,
  maxLookback = 1000
): Promise<number> {
  const opts = { maxSupportedTransactionVersion: 0, transactionDetails: "none", rewards: false } as const;
  const { slot: finalizedSlot } = await getNearestSlotTime(provider, { commitment: "finalized" });
  const endSlot = biMin(maxSlot, finalizedSlot);

  let slot = endSlot;
  do {
    const block = await provider.getBlock(slot, opts).send();
    if (isDefined(block) && [block.blockHeight, block.blockTime].every(isDefined)) {
      break;
    }
  } while (--maxLookback > 0 && --slot > 0);

  if (maxLookback === 0) {
    throw new Error(`Unable to find Solana block between slots [${slot}, ${endSlot}]`);
  }

  return Number(slot);
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
  uint8ArrayKeysAsBigInt: string[] = ["depositId", "outputAmount", "inputAmount"],
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
 * @param rootBundleId the associated root bundle ID.
 */
export async function getRootBundlePda(programId: Address, rootBundleId: number): Promise<Address> {
  const seedEncoder = getU64Encoder();
  const seed = seedEncoder.encode(0); // Default seed.

  const intEncoder = getU32Encoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["root_bundle", seed, intEncoder.encode(rootBundleId)],
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
 * Returns the PDA for an individual's claim account.
 * @param programId the address of the spoke pool.
 * @param mint the address of the token.
 * @param tokenOwner the address of the signer which owns the claim account.
 */
export async function getClaimAccountPda(programId: Address, mint: Address, tokenOwner: Address): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: ["claim_account", addressEncoder.encode(mint), addressEncoder.encode(tokenOwner)],
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
 * Returns the PDA for the Self Authority.
 * @returns The PDA for the Self Authority.
 */
export const getSelfAuthority = async () => {
  const [selfAuthority] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: ["self_authority"],
  });
  return selfAuthority;
};

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
 * Simulates a transaction and decodes the result using a parser function.
 * @param solanaClient - The Solana client.
 * @param ix - The instruction to simulate.
 * @param signer - The signer of the transaction.
 * @param parser - The parser function to decode the result.
 * @returns The decoded result.
 */
export const simulateAndDecode = async <P extends (buf: Buffer) => unknown>(
  solanaClient: SVMProvider,
  ix: IInstruction,
  signer: KeyPairSigner,
  parser: P
): Promise<ReturnType<P>> => {
  const simulationTx = appendTransactionMessageInstruction(ix, await createDefaultTransaction(solanaClient, signer));

  const simulationResult = await solanaClient
    .simulateTransaction(getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(simulationTx)), {
      encoding: "base64",
    })
    .send();

  if (!simulationResult.value.returnData?.data[0]) {
    throw new Error("No return data");
  }

  return parser(Buffer.from(simulationResult.value.returnData.data[0], "base64")) as ReturnType<P>;
};

/**
 * Returns the PDA for the CCTP nonce.
 * @param solanaClient The Solana client.
 * @param signer The signer of the transaction.
 * @param nonce The nonce to get the PDA for.
 * @param sourceDomain The source domain.
 * @returns The PDA for the CCTP nonce.
 */
export const getCCTPNoncePda = async (
  solanaClient: SVMProvider,
  signer: KeyPairSigner,
  nonce: number,
  sourceDomain: number
) => {
  const [messageTransmitterPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["message_transmitter"],
  });
  const getNonceIx = await MessageTransmitterClient.getGetNoncePdaInstruction({
    messageTransmitter: messageTransmitterPda,
    nonce,
    sourceDomain: sourceDomain,
  });

  const parserFunction = (buf: Buffer): Address => {
    if (buf.length === 32) {
      return address(bs58.encode(buf));
    }
    throw new Error("Invalid buffer");
  };

  return await simulateAndDecode(solanaClient, getNonceIx, signer, parserFunction);
};

/**
 * Checks if a CCTP message is a deposit for burn event.
 * @param event The CCTP message event.
 * @returns True if the message is a deposit for burn event, false otherwise.
 */
export function isDepositForBurnEvent(event: AttestedCCTPMessage): boolean {
  return event.type === "transfer";
}

/**
 * True if `body` encodes a `relayRootBundle(bytes32,bytes32)` call.
 */
export const isRelayRootBundleMessageBody = (body: Buffer): boolean => {
  if (body.length < 4) return false;

  const spokePoolInterface = new ethers.utils.Interface(SpokePool__factory.abi);
  const relayRootBundleSelector = spokePoolInterface.getSighash("relayRootBundle");

  return body.slice(0, 4).equals(Buffer.from(relayRootBundleSelector.slice(2), "hex"));
};

/**
 * True if `body` encodes a `emergencyDeleteRootBundle(uint32)` call.
 */
export const isEmergencyDeleteRootBundleMessageBody = (body: Buffer): boolean => {
  if (body.length < 4) return false;

  const spokePoolInterface = new ethers.utils.Interface(SpokePool__factory.abi);
  const emergencyDeleteRootBundleSelector = spokePoolInterface.getSighash("emergencyDeleteRootBundle");

  return body.slice(0, 4).equals(Buffer.from(emergencyDeleteRootBundleSelector.slice(2), "hex"));
};

/**
 * Decodes the root bundle ID from an emergency delete root bundle message body.
 * @param body The message body.
 * @returns The root bundle ID.
 */
export const getEmergencyDeleteRootBundleRootBundleId = (body: Buffer): number => {
  const spokePoolInterface = new ethers.utils.Interface(SpokePool__factory.abi);
  const result = spokePoolInterface.decodeFunctionData("emergencyDeleteRootBundle", body);
  return result.rootBundleId.toNumber();
};

/**
 * Convert a bigint (0 ≤ n < 2^256) to a 32-byte Uint8Array (big-endian).
 * @param n The bigint to convert.
 * @returns The 32-byte Uint8Array.
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
