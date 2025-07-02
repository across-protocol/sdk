import {
  CHAIN_IDs,
  MessageTransmitterClient,
  SvmSpokeClient,
  TOKEN_SYMBOLS_MAP,
  TokenMessengerMinterClient,
} from "@across-protocol/contracts";
import { BN, BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  AccountRole,
  Address,
  IAccountMeta,
  IInstruction,
  KeyPairSigner,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU32Encoder,
  getU64Encoder,
  isAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { ethers } from "ethers";
import { FillType, RelayData } from "../../interfaces";
import {
  BigNumber,
  EvmAddress,
  Address as SdkAddress,
  SvmAddress,
  chainIsProd,
  getRelayDataHash,
  isUint8Array,
  mapAsync,
} from "../../utils";
import { createReceiveMessageInstruction, getAssociatedTokenAddress } from "./SpokeUtils";
import { AttestedCCTPMessage, EventName, SVMEventNames, SVMProvider } from "./types";

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
 * Checks if a CCTP message has been processed.
 * @param solanaClient The Solana client.
 * @param signer The signer of the transaction.
 * @param nonce The nonce to check.
 * @param sourceDomain The source domain.
 * @returns True if the message has been processed, false otherwise.
 */
export const hasCCTPV1MessageBeenProcessed = async (
  solanaClient: SVMProvider,
  signer: KeyPairSigner,
  nonce: number,
  sourceDomain: number
): Promise<boolean> => {
  const noncePda = await getCCTPNoncePda(solanaClient, signer, nonce, sourceDomain);
  const isNonceUsedIx = await MessageTransmitterClient.getIsNonceUsedInstruction({
    nonce: nonce,
    usedNonces: noncePda,
  });
  const parserFunction = (buf: Buffer): boolean => {
    if (buf.length != 1) {
      throw new Error("Invalid buffer length for isNonceUsedIx");
    }
    return Boolean(buf[0]);
  };
  return await simulateAndDecode(solanaClient, isNonceUsedIx, signer, parserFunction);
};

/**
 * Checks if a CCTP message is a deposit for burn event.
 * @param event The CCTP message event.
 * @returns True if the message is a deposit for burn event, false otherwise.
 */
export function isDepositForBurnEvent(event: AttestedCCTPMessage): boolean {
  return "amount" in event && "mintRecipient" in event && "burnToken" in event;
}

/**
 * Returns the account metas for a tokenless message.
 * @returns The account metas for a tokenless message.
 */
export async function getAccountMetasForTokenlessMessage(): Promise<IAccountMeta<string>[]> {
  const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  return [
    { address: statePda, role: AccountRole.READONLY },
    { address: await getSelfAuthority(), role: AccountRole.READONLY },
    { address: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: statePda, role: AccountRole.WRITABLE },
    { address: await getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS), role: AccountRole.READONLY },
    { address: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ];
}

/**
 * Returns the account metas for a deposit message.
 * @param message The CCTP message.
 * @param hubChainId The chain ID of the hub.
 * @param tokenMessengerMinter The token messenger minter address.
 * @returns The account metas for a deposit message.
 */
async function getAccountMetasForDepositMessage(
  message: AttestedCCTPMessage,
  hubChainId: number,
  tokenMessengerMinter: Address
): Promise<IAccountMeta<string>[]> {
  const l1Usdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]);
  const l2Usdc = SvmAddress.from(
    TOKEN_SYMBOLS_MAP.USDC.addresses[chainIsProd(hubChainId) ? CHAIN_IDs.SOLANA : CHAIN_IDs.SOLANA_DEVNET]
  );

  const [tokenMessengerPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["token_messenger"],
  });

  const [tokenMinterPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["token_minter"],
  });

  const [localTokenPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["local_token", bs58.decode(l2Usdc.toBase58())],
  });

  const [tokenMessengerEventAuthorityPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["__event_authority"],
  });

  const [custodyTokenAccountPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["custody", bs58.decode(l2Usdc.toBase58())],
  });

  const state = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const vault = await getAssociatedTokenAddress(
    SvmAddress.from(state),
    SvmAddress.from(l2Usdc.toBase58()),
    tokenProgram
  );

  // Define accounts dependent on deposit information.
  const [tokenPairPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: [
      new Uint8Array(Buffer.from("token_pair")),
      new Uint8Array(Buffer.from(String(message.sourceDomain))),
      new Uint8Array(Buffer.from(l1Usdc.toBytes32().slice(2), "hex")),
    ],
  });

  const [remoteTokenMessengerPda] = await getProgramDerivedAddress({
    programAddress: tokenMessengerMinter,
    seeds: ["remote_token_messenger", Buffer.from(String(message.sourceDomain))],
  });

  return [
    { address: tokenMessengerPda, role: AccountRole.READONLY },
    { address: remoteTokenMessengerPda, role: AccountRole.READONLY },
    { address: tokenMinterPda, role: AccountRole.WRITABLE },
    { address: localTokenPda, role: AccountRole.WRITABLE },
    { address: tokenPairPda, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE },
    { address: custodyTokenAccountPda, role: AccountRole.WRITABLE },
    { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: tokenMessengerEventAuthorityPda, role: AccountRole.READONLY },
    { address: tokenMessengerMinter, role: AccountRole.READONLY },
  ];
}

/**
 * Finalizes CCTP deposits and messages on Solana.
 *
 * @param solanaClient The Solana client.
 * @param attestedMessages The CCTP messages to Solana.
 * @param signer A base signer to be converted into a Solana signer.
 * @param simulate Whether to simulate the transaction.
 * @param hubChainId The chain ID of the hub.
 * @returns A list of executed transaction signatures.
 */

export async function finalizeCCTPV1Messages(
  solanaClient: SVMProvider,
  attestedMessages: AttestedCCTPMessage[],
  signer: KeyPairSigner,
  simulate = false,
  hubChainId = 1
): Promise<string[]> {
  const [messageTransmitterPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["message_transmitter"],
  });

  const [eventAuthorityPda] = await getProgramDerivedAddress({
    programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    seeds: ["__event_authority"],
  });

  return mapAsync(attestedMessages, async (message) => {
    const cctpMessageReceiver = isDepositForBurnEvent(message)
      ? TokenMessengerMinterClient.TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS
      : SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;

    const [authorityPda] = await getProgramDerivedAddress({
      programAddress: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
      seeds: ["message_transmitter_authority", bs58.decode(cctpMessageReceiver)],
    });

    // Notice: message.nonce is only valid for v1 messages
    const usedNonces = await getCCTPNoncePda(solanaClient, signer, message.nonce, message.sourceDomain);

    // Notice: for Svm tokenless messages, we currently only support very specific finalizations: Hub -> Spoke relayRootBundle calls
    const accountMetas: IAccountMeta<string>[] = isDepositForBurnEvent(message)
      ? await getAccountMetasForDepositMessage(
          message,
          hubChainId,
          TokenMessengerMinterClient.TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS
        )
      : await getAccountMetasForTokenlessMessage();

    const messageBytes = message.messageBytes.startsWith("0x")
      ? Buffer.from(message.messageBytes.slice(2), "hex")
      : Buffer.from(message.messageBytes, "hex");

    const input: MessageTransmitterClient.ReceiveMessageInput = {
      program: MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
      payer: signer,
      caller: signer,
      authorityPda,
      messageTransmitter: messageTransmitterPda,
      eventAuthority: eventAuthorityPda,
      usedNonces,
      receiver: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      message: messageBytes,
      attestation: Buffer.from(message.attestation.slice(2), "hex"),
    };

    const receiveMessageIx = await createReceiveMessageInstruction(signer, solanaClient, input, accountMetas);

    if (simulate) {
      await solanaClient
        .simulateTransaction(
          getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(receiveMessageIx)),
          {
            encoding: "base64",
          }
        )
        .send();
      return "";
    }

    const signedTransaction = await signTransactionMessageWithSigners(receiveMessageIx);
    const signature = getSignatureFromTransaction(signedTransaction);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    await solanaClient
      .sendTransaction(encodedTransaction, { preflightCommitment: "confirmed", encoding: "base64" })
      .send();

    return signature;
  });
}

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
