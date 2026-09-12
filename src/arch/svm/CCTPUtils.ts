import { MessageTransmitterV2Client, SvmSpokeClient, TokenMessengerMinterV2Client } from "@across-protocol/contracts";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  AccountMeta,
  AccountRole,
  Address,
  TransactionSigner,
  ReadonlyUint8Array,
  appendTransactionMessageInstruction,
  compressTransactionMessageUsingAddressLookupTables,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU32Encoder,
  getU64Encoder,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { ethers } from "ethers";
import assert from "assert";
import { array, create, number, string, type } from "superstruct";
import { CCTPV2_FINALITY_THRESHOLD_STANDARD, SvmAddress, fetchWithTimeout, isHttpError } from "../../utils";
import { getAssociatedTokenAddress } from "./SpokeUtils";
import { createDefaultTransaction, getEventAuthority, getSelfAuthority, getStatePda } from "./utils";
import { AttestedCCTPV2Message, SolanaTransaction, SVMProvider } from "./types";

const transmitter = MessageTransmitterV2Client.MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS;
const tokenMessenger = TokenMessengerMinterV2Client.TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS;
const spoke = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const spokeInterface = new ethers.utils.Interface([
  "function pauseDeposits(bool pause)",
  "function pauseFills(bool pause)",
  "function setCrossDomainAdmin(address newCrossDomainAdmin)",
  "function relayRootBundle(bytes32 relayerRefundRoot, bytes32 slowRelayRoot)",
  "function emergencyDeleteRootBundle(uint256 rootBundleId)",
]);

function bytes(value: string | ReadonlyUint8Array): Buffer {
  if (typeof value !== "string") return Buffer.from(value);
  const hex = value.replace(/^0x/, "");
  assert(/^(?:[\da-fA-F]{2})*$/.test(hex), "Invalid CCTP hex bytes");
  return Buffer.from(hex, "hex");
}

/** CCTP V2 uses wire version 1 and a 32-byte nonce supplied by the attester. */
export function decodeCCTPV2Message(message: string | ReadonlyUint8Array) {
  const data = bytes(message);
  assert(data.length >= 148, "Invalid CCTP V2 message header");
  assert(data.readUInt32BE(0) === 1, "Expected CCTP V2 wire version 1");
  return {
    sourceDomain: data.readUInt32BE(4),
    destinationDomain: data.readUInt32BE(8),
    nonce: data.subarray(12, 44),
    sender: addressDecoder.decode(data.subarray(44, 76)),
    recipient: addressDecoder.decode(data.subarray(76, 108)),
    destinationCaller: addressDecoder.decode(data.subarray(108, 140)),
    minFinalityThreshold: data.readUInt32BE(140),
    finalityThresholdExecuted: data.readUInt32BE(144),
    messageBody: data.subarray(148),
  };
}

export function decodeCCTPV2BurnMessage(messageBody: string | ReadonlyUint8Array) {
  const data = bytes(messageBody);
  assert(data.length >= 228 && data.readUInt32BE(0) === 1, "Invalid CCTP V2 burn message body");
  const uint256 = (offset: number) => BigInt(`0x${data.subarray(offset, offset + 32).toString("hex")}`);
  return {
    burnToken: addressDecoder.decode(data.subarray(4, 36)),
    mintRecipient: addressDecoder.decode(data.subarray(36, 68)),
    amount: uint256(68),
    messageSender: addressDecoder.decode(data.subarray(100, 132)),
    maxFee: uint256(132),
    feeExecuted: uint256(164),
    expirationBlock: uint256(196),
    hookData: data.subarray(228),
  };
}

/** V2 has one used_nonce PDA per message; no source domain, sequence or RPC simulation is involved. */
export async function getCCTPNoncePda(nonce: string | ReadonlyUint8Array): Promise<Address> {
  const seed = bytes(nonce);
  assert(seed.length === 32, "CCTP V2 nonce must be 32 bytes");
  const [pda] = await getProgramDerivedAddress({ programAddress: transmitter, seeds: ["used_nonce", seed] });
  return pda;
}

export async function hasCCTPV2MessageBeenProcessed(
  rpc: SVMProvider,
  nonce: string | ReadonlyUint8Array
): Promise<boolean> {
  const account = await MessageTransmitterV2Client.fetchMaybeUsedNonce(rpc, await getCCTPNoncePda(nonce), {
    commitment: "confirmed",
  });
  return account.exists && account.data.isUsed;
}

/** Resolve all five Spoke receiver calls against current state, including root bundle IDs. */
export async function getAccountMetasForTokenlessMessage(
  rpc: SVMProvider,
  signer: TransactionSigner,
  messageBytes: string
): Promise<AccountMeta[]> {
  const header = decodeCCTPV2Message(messageBytes);
  assert(header.recipient === spoke && header.destinationDomain === 5, "Message is not addressed to the Solana spoke");
  assert(
    header.finalityThresholdExecuted >= CCTPV2_FINALITY_THRESHOLD_STANDARD,
    "Spoke messages require finalized attestations"
  );
  const statePda = await getStatePda(spoke);
  const { data: state } = await SvmSpokeClient.fetchState(rpc, statePda, { commitment: "confirmed" });
  assert(
    header.sourceDomain === state.remoteDomain && header.sender === state.crossDomainAdmin,
    "Message does not match the spoke's remote domain and admin"
  );
  const call = spokeInterface.parseTransaction({ data: ethers.utils.hexlify(header.messageBody) });
  const readonly = AccountRole.READONLY;
  const writable = AccountRole.WRITABLE;
  const accounts: AccountMeta[] = [
    { address: statePda, role: readonly },
    { address: await getSelfAuthority(), role: readonly },
    { address: spoke, role: readonly },
  ];
  if (call.name === "relayRootBundle" || call.name === "emergencyDeleteRootBundle") {
    const relay = call.name === "relayRootBundle";
    const rootBundleId = relay ? state.rootBundleId : call.args.rootBundleId.toNumber();
    assert(rootBundleId >= 0 && rootBundleId <= 0xffffffff, "Root bundle ID must fit in u32");
    const [rootBundle] = await getProgramDerivedAddress({
      programAddress: spoke,
      seeds: ["root_bundle", getU64Encoder().encode(state.seed), getU32Encoder().encode(rootBundleId)],
    });
    accounts.push(
      { address: signer.address, role: relay ? AccountRole.WRITABLE_SIGNER : writable },
      { address: statePda, role: relay ? writable : readonly },
      { address: rootBundle, role: writable }
    );
    if (relay) accounts.push({ address: SYSTEM_PROGRAM_ADDRESS, role: readonly });
  } else {
    accounts.push({ address: statePda, role: writable });
  }
  return [...accounts, { address: await getEventAuthority(spoke), role: readonly }, { address: spoke, role: readonly }];
}

/** Token delivery uses Circle's mapping and the attested recipient, including the separate fee account. */
export async function getAccountMetasForCCTPV2TokenMessage(
  rpc: SVMProvider,
  messageBytes: string,
  expectedRecipient?: Address
): Promise<AccountMeta[]> {
  const header = decodeCCTPV2Message(messageBytes);
  assert(
    header.recipient === tokenMessenger && header.destinationDomain === 5,
    "Message is not addressed to Solana TokenMessengerV2"
  );
  const body = decodeCCTPV2BurnMessage(header.messageBody);
  if (expectedRecipient !== undefined)
    assert(body.mintRecipient === expectedRecipient, "Unexpected CCTP mint recipient");
  const pda = async (name: string, ...seeds: (string | ReadonlyUint8Array)[]) =>
    (await getProgramDerivedAddress({ programAddress: tokenMessenger, seeds: [name, ...seeds] }))[0];
  const domain = String(header.sourceDomain);
  const [tokenPair, messenger] = await Promise.all([
    pda("token_pair", domain, addressEncoder.encode(body.burnToken)),
    pda("token_messenger"),
  ]);
  const [pair, messengerAccount] = await Promise.all([
    TokenMessengerMinterV2Client.fetchTokenPair(rpc, tokenPair, { commitment: "confirmed" }),
    TokenMessengerMinterV2Client.fetchTokenMessenger(rpc, messenger, { commitment: "confirmed" }),
  ]);
  const { data: localToken } = await TokenMessengerMinterV2Client.fetchLocalToken(rpc, pair.data.localToken, {
    commitment: "confirmed",
  });
  const feeRecipient = await getAssociatedTokenAddress(
    SvmAddress.from(messengerAccount.data.feeRecipient),
    SvmAddress.from(localToken.mint)
  );
  const accounts: [Address, AccountRole][] = [
    [messenger, AccountRole.READONLY],
    [await pda("remote_token_messenger", domain), AccountRole.READONLY],
    [await pda("token_minter"), AccountRole.READONLY],
    [pair.data.localToken, AccountRole.WRITABLE],
    [tokenPair, AccountRole.READONLY],
    [feeRecipient, AccountRole.WRITABLE],
    [body.mintRecipient, AccountRole.WRITABLE],
    [localToken.custody, AccountRole.WRITABLE],
    [TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY],
    [await getEventAuthority(tokenMessenger), AccountRole.READONLY],
    [tokenMessenger, AccountRole.READONLY],
  ];
  return accounts.map(([address, role]) => ({ address, role }));
}

export async function createReceiveMessageInstruction(
  signer: TransactionSigner,
  rpc: SVMProvider,
  input: MessageTransmitterV2Client.ReceiveMessageInput,
  remainingAccounts: AccountMeta[]
): Promise<SolanaTransaction> {
  const ix = MessageTransmitterV2Client.getReceiveMessageInstruction(input);
  return appendTransactionMessageInstruction(
    { ...ix, accounts: [...ix.accounts, ...remainingAccounts] },
    await createDefaultTransaction(rpc, signer)
  );
}

export async function getCCTPV2ReceiveMessageTx(
  rpc: SVMProvider,
  signer: TransactionSigner,
  message: AttestedCCTPV2Message,
  expectedTokenRecipient?: Address
): Promise<SolanaTransaction> {
  const header = decodeCCTPV2Message(message.messageBytes);
  assert(header.destinationDomain === 5, "CCTP message destination must be Solana");
  assert(
    header.destinationCaller === SYSTEM_PROGRAM_ADDRESS || header.destinationCaller === signer.address,
    "Signer does not match CCTP destination caller"
  );
  assert(header.recipient === spoke || header.recipient === tokenMessenger, "Unsupported CCTP receiver");
  const accounts =
    header.recipient === spoke
      ? await getAccountMetasForTokenlessMessage(rpc, signer, message.messageBytes)
      : await getAccountMetasForCCTPV2TokenMessage(rpc, message.messageBytes, expectedTokenRecipient);
  const [[messageTransmitter], [authorityPda], usedNonce, eventAuthority] = await Promise.all([
    getProgramDerivedAddress({ programAddress: transmitter, seeds: ["message_transmitter"] }),
    getProgramDerivedAddress({
      programAddress: transmitter,
      seeds: ["message_transmitter_authority", addressEncoder.encode(header.recipient)],
    }),
    getCCTPNoncePda(header.nonce),
    getEventAuthority(transmitter),
  ]);
  return createReceiveMessageInstruction(
    signer,
    rpc,
    {
      program: transmitter,
      payer: signer,
      caller: signer,
      authorityPda,
      messageTransmitter,
      eventAuthority,
      usedNonce,
      receiver: header.recipient,
      message: bytes(message.messageBytes),
      attestation: bytes(message.attestation),
    },
    accounts
  );
}

/** Deliver in input order, confirming each message before resolving the next one's mutable Spoke state.
 * Returns null for an already processed nonce (including races with another finalizer), and "" for simulation.
 * Callers can use getCCTPV2ReceiveMessageTx with their own signing/submission infrastructure instead.
 */
export async function finalizeCCTPV2Messages(
  rpc: SVMProvider,
  messages: AttestedCCTPV2Message[],
  signer: TransactionSigner,
  options: { simulate?: boolean; expectedTokenRecipient?: Address; lookupTables?: Record<string, Address[]> } = {}
): Promise<(string | null)[]> {
  const signatures: (string | null)[] = [];
  for (const message of messages) {
    const { nonce } = decodeCCTPV2Message(message.messageBytes);
    const processed = () => hasCCTPV2MessageBeenProcessed(rpc, nonce);
    // Admin updates and deleted roots must be replay-safe even when the receiver's state has changed.
    if (await processed()) {
      signatures.push(null);
      continue;
    }
    try {
      let tx = await getCCTPV2ReceiveMessageTx(rpc, signer, message, options.expectedTokenRecipient);
      if (options.lookupTables) tx = compressTransactionMessageUsingAddressLookupTables(tx, options.lookupTables);
      const signed = await signTransactionMessageWithSigners(tx);
      const encoded = getBase64EncodedWireTransaction(signed);
      if (options.simulate) {
        const { value } = await rpc
          .simulateTransaction(encoded, { encoding: "base64", commitment: "confirmed" })
          .send();
        assert(!value.err, `CCTP simulation failed: ${JSON.stringify(value.err)}`);
        signatures.push("");
        continue;
      }
      const signature = getSignatureFromTransaction(signed);
      await rpc.sendTransaction(encoded, { encoding: "base64", preflightCommitment: "confirmed" }).send();
      let confirmed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const {
          value: [status],
        } = await rpc.getSignatureStatuses([signature]).send();
        assert(!status?.err, `CCTP delivery failed: ${JSON.stringify(status?.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          confirmed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert(confirmed, `CCTP transaction ${signature} was not confirmed; retry the message`);
      signatures.push(signature);
    } catch (error) {
      if (!(await processed())) throw error;
      signatures.push(null);
    }
  }
  return signatures;
}

const attestationResponse = type({
  messages: array(
    type({
      cctpVersion: number(),
      status: string(),
      message: string(),
      attestation: string(),
    })
  ),
});

/** Poll Iris for V2 attestations. Select by attested bytes, never Iris's decoded metadata. */
export async function fetchCCTPV2Messages(
  transactionHash: string,
  sourceDomain: number,
  isMainnet: boolean,
  options: { timeoutMs?: number; pollIntervalMs?: number; recipient?: Address; nonce?: string } = {}
): Promise<AttestedCCTPV2Message[]> {
  const { timeoutMs = 120_000, pollIntervalMs = 2000 } = options;
  assert(transactionHash.length > 0, "Source transaction hash is required");
  assert(
    Number.isInteger(sourceDomain) && sourceDomain >= 0 && sourceDomain <= 0xffffffff,
    "Invalid CCTP source domain"
  );
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0,
    "Invalid polling timeout or interval"
  );
  const selectedNonce = options.nonce === undefined ? undefined : bytes(options.nonce);
  assert(selectedNonce === undefined || selectedNonce.length === 32, "CCTP V2 nonce must be 32 bytes");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let response: unknown;
    try {
      response = await fetchWithTimeout(
        `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/v2/messages/${sourceDomain}`,
        { transactionHash },
        {},
        Math.min(10_000, Math.max(1, deadline - Date.now()))
      );
    } catch (error) {
      if (!isHttpError(error) || (error.status !== 404 && error.status !== 429 && error.status < 500)) throw error;
    }
    if (response !== undefined) {
      const { messages } = create(response, attestationResponse);
      const v2 = messages.filter((message) => message.cctpVersion === 2);
      assert(!messages.length || v2.length, "Source transaction contains no CCTP V2 messages");
      // A pending message may have no attested bytes yet. Do not decode it or mistake it for a completed message.
      if (v2.length && v2.every((message) => message.status === "complete")) {
        const matching = v2.filter((message) => {
          const header = decodeCCTPV2Message(message.message);
          return (
            header.sourceDomain === sourceDomain &&
            header.destinationDomain === 5 &&
            (options.recipient === undefined
              ? header.recipient === spoke || header.recipient === tokenMessenger
              : header.recipient === options.recipient) &&
            (selectedNonce === undefined || header.nonce.equals(selectedNonce))
          );
        });
        assert(matching.length, "No matching CCTP V2 messages addressed to the selected Solana receiver");
        return matching.map(({ message, attestation }) => {
          assert(bytes(attestation).length > 0, "Missing completed CCTP attestation");
          return { messageBytes: message, attestation };
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(
    `Timed out waiting for CCTP V2 attestations for ${transactionHash}; retry the same source transaction`
  );
}
