import { Idl } from "@coral-xyz/anchor";
import { getDeployedAddress, SvmSpokeIdl } from "@across-protocol/contracts";
import { getSolanaChainId } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import {
  address,
  Address,
  Commitment,
  getProgramDerivedAddress,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  Signature,
} from "@solana/kit";
import { bs58, chainIsSvm, getMessageHash, isDefined } from "../../utils";
import {
  DecodedEvent,
  EventName,
  EventWithData,
  RawDecodedEvent,
  RawEventWithData,
  SVMEventNames,
  SVMProvider,
} from "./types";
import { decodeEvent, getFillStatusPda, isDevnet } from "./utils";
import { DepositWithTime, FillWithTime, RelayDataWithMessageHash } from "../../interfaces";
import { depositFromEvent, fillFromEvent, getRelayDataHash, getRelayDataHashFromEvent } from "./";
import assert from "assert";

/**
 * Anchor emits CPI events (`emit_cpi!`) as a *self*-invocation of the program that targets its
 * `__event_authority` PDA and prefixes the instruction data with this fixed 8-byte discriminator,
 * followed by the 8-byte event discriminator and the Borsh event payload. The wire bytes are the
 * little-endian encoding of Anchor's `EVENT_IX_TAG: u64 = 0x1d9acb512ea545e4` (the first 8 bytes of
 * `sha256("anchor:event")` read as a big-endian u64) — i.e. the digest prefix in *reversed* byte
 * order. Checking this prefix is what proves an inner instruction is a genuine emitted event and
 * not just some other instruction that happens to touch the program. Without it, any program can
 * forge an event by CPI-ing into the SpokePool with the event authority passed as the sole account
 * and attacker-controlled trailing data (e.g. via the read-only `GetUnsafeDepositId` instruction),
 * which the client would otherwise decode as a real FundsDeposited/FilledRelay event.
 */
const ANCHOR_CPI_EVENT_DISCRIMINATOR = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

// Utility type to extract the return type for the JSON encoding overload. We only care about the overload where the
// configuration parameter (C) has the optional property 'encoding' set to 'json'.
type ExtractJsonOverload<T> = T extends (signature: infer _S, config: infer C) => infer R
  ? C extends { encoding?: "json" }
    ? R
    : never
  : never;

type GetTransactionReturnType = ExtractJsonOverload<GetTransactionApi["getTransaction"]>;
type GetSignaturesForAddressConfig = Parameters<GetSignaturesForAddressApi["getSignaturesForAddress"]>[1];
type GetSignaturesForAddressTransaction = ReturnType<GetSignaturesForAddressApi["getSignaturesForAddress"]>[number];
type GetSignaturesForAddressApiResponse = readonly GetSignaturesForAddressTransaction[];

export type DepositEventFromSignature = Omit<DepositWithTime, "fromLiteChain" | "toLiteChain">;
export type FillEventFromSignature = FillWithTime;

// The events that embed the relay data of the relay they pertain to (see queryEventsForRelay()).
export type RelayEventName = Extract<EventName, "FilledRelay" | "RequestedSlowFill">;

export class SvmCpiEventsClient {
  private rpc: SVMProvider;
  private programAddress: Address;
  private programEventAuthority: Address;
  private idl: Idl;

  /**
   * Note: Strongly prefer to use the async create() method to instantiate.
   */
  constructor(rpc: SVMProvider, address: Address, eventAuthority: Address, idl: Idl) {
    this.rpc = rpc;
    this.programAddress = address;
    this.programEventAuthority = eventAuthority;
    this.idl = idl;
  }

  /**
   * Factory method to asynchronously create an instance of SvmSpokeEventsClient.
   */
  public static async create(rpc: SVMProvider): Promise<SvmCpiEventsClient> {
    const isTestnet = await isDevnet(rpc);
    const programId = getDeployedAddress("SvmSpoke", getSolanaChainId(isTestnet ? "devnet" : "mainnet").toString());
    if (!programId) throw new Error("Program not found");
    return this.createFor(rpc, programId, SvmSpokeIdl);
  }

  public static async createFor(rpc: SVMProvider, programId: string, idl: Idl): Promise<SvmCpiEventsClient> {
    const programAddress = address(programId);
    const [eventAuthority] = await getProgramDerivedAddress({
      programAddress,
      seeds: ["__event_authority"],
    });
    return new SvmCpiEventsClient(rpc, programAddress, eventAuthority, idl);
  }

  /**
   * Queries events for the SvmSpoke program filtered by event name.
   *
   * @param eventName - The name of the event to filter by.
   * @param fromSlot - Optional starting slot.
   * @param toSlot - Optional ending slot.
   * @param options - Options for fetching signatures.
   * @returns A promise that resolves to an array of events matching the eventName.
   */
  public async queryEvents<T extends EventName>(
    eventName: T,
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" }
  ): Promise<EventWithData<T>[]> {
    const events = await this.queryAllEvents(fromSlot, toSlot, options);
    return events.filter((event): event is EventWithData<T> => event.name === eventName);
  }

  /**
   * Queries FilledRelay and/or RequestedSlowFill events pertaining to a specific relay.
   *
   * Events are located via the relay's fillStatus PDA, but Solana only indexes transactions by account, so the
   * underlying query yields all program events from any transaction touching that PDA - including events for
   * other relays (e.g. from batched fills). Each event is therefore associated back to the relay by its relay
   * data hash, the same hash the fillStatus PDA is derived from; events belonging to other relays are dropped.
   * Signatures are paginated to exhaustion within the slot bounds, so transactions spamming the PDA can add
   * latency but cannot displace the relay's own events. A caller-supplied fillStatus PDA is likewise only a
   * transaction locator: association is by relay data hash, so a stale or incorrect PDA can only yield missing
   * events, never another relay's.
   *
   * @param relayData - Relay data identifying the relay to query events for.
   * @param destinationChainId - Destination chain ID of the relay (must be an SVM chain).
   * @param eventNames - The names of the events to filter by (FilledRelay and/or RequestedSlowFill).
   * @param opts - Optional slot bounds, a precomputed fillStatus PDA and the commitment level (default:
   * confirmed), which applies to both the signature listing and the transaction reads.
   * @returns A promise that resolves to an array of events pertaining to the relay.
   */
  public async queryEventsForRelay(
    relayData: RelayDataWithMessageHash,
    destinationChainId: number,
    eventNames: RelayEventName[],
    opts: {
      fromSlot?: bigint;
      toSlot?: bigint;
      fillStatusPda?: Address;
      commitment?: Exclude<Commitment, "processed">;
    } = {}
  ): Promise<EventWithData<RelayEventName>[]> {
    assert(chainIsSvm(destinationChainId), `Destination chain ${destinationChainId} is not an SVM chain`);
    const { commitment = "confirmed" } = opts;
    const fillStatusPda =
      opts.fillStatusPda ?? (await getFillStatusPda(this.programAddress, relayData, destinationChainId));
    const messageHash = relayData.messageHash ?? getMessageHash(relayData.message);
    const relayDataHash = getRelayDataHash({ ...relayData, messageHash }, destinationChainId);

    const events = await this.queryAllEvents(opts.fromSlot, opts.toSlot, { limit: 1000, commitment }, fillStatusPda);
    return events
      .filter((event): event is EventWithData<RelayEventName> => eventNames.some((name) => name === event.name))
      .filter((event) => getRelayDataHashFromEvent(event.data, destinationChainId) === relayDataHash);
  }

  /**
   * Queries events for the provided derived address, filtered by event name. This is the generic query for
   * programs without SpokePool-specific handling (e.g. the CCTP TokenMessengerMinter and MessageTransmitter).
   *
   * note: The returned events are scoped to *transactions* referencing the derived address; any event emitted
   * by such a transaction is returned, whether or not the event pertains to the derived address (e.g. a
   * batched fill emits events for many relays, all of which are returned for each relay's fillStatus PDA).
   * Callers must associate events with the derived address themselves; for SvmSpoke relay events, prefer
   * queryEventsForRelay(), which does this association by relay data hash.
   *
   * @param eventName - The name of the event to filter by.
   * @param derivedAddress - The derived address whose referencing transactions are queried.
   * @param fromSlot - Optional starting slot.
   * @param toSlot - Optional ending slot.
   * @param options - Options for fetching signatures.
   * @returns A promise that resolves to an array of events matching the eventName.
   */
  public async queryDerivedAddressEvents(
    eventName: string,
    derivedAddress: Address,
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" }
  ): Promise<RawEventWithData[]> {
    const events = await this.queryAllEvents(fromSlot, toSlot, options, derivedAddress);
    return events.filter((event) => event.name === eventName);
  }

  /**
   * Queries all events for a specific program.
   *
   * @param fromSlot - Optional starting slot.
   * @param toSlot - Optional ending slot.
   * @param options - Options for fetching signatures.
   * @param forDerivedAddress - Whether to query events for the program or the derived address.
   * @returns A promise that resolves to an array of all events with additional metadata.
   */
  private async queryAllEvents(
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" },
    derivedAddress?: Address
  ): Promise<RawEventWithData[]> {
    const addressToQuery = derivedAddress || this.programAddress;
    const allSignatures: GetSignaturesForAddressTransaction[] = [];
    let hasMoreSignatures = true;
    let currentOptions = { ...options, encoding: "json" };

    while (hasMoreSignatures) {
      const signatures: GetSignaturesForAddressApiResponse = await this.rpc
        .getSignaturesForAddress(addressToQuery, currentOptions)
        .send();
      // Signatures are sorted by slot in descending order.
      allSignatures.push(...signatures);

      // Update options for the next batch. Set "before" to the last fetched signature.
      if (signatures.length > 0) {
        currentOptions = { ...currentOptions, before: signatures[signatures.length - 1].signature };
      }

      if (fromSlot && allSignatures.length > 0 && allSignatures[allSignatures.length - 1].slot < fromSlot) {
        hasMoreSignatures = false;
      }

      hasMoreSignatures = Boolean(
        hasMoreSignatures && currentOptions.limit && signatures.length === currentOptions.limit
      );
    }

    const filteredSignatures = allSignatures.filter((signatureTransaction) => {
      if (fromSlot && signatureTransaction.slot < fromSlot) return false;
      if (toSlot && signatureTransaction.slot > toSlot) return false;
      return true;
    });

    // Fetch events for all signatures in parallel. Dispatch is unbounded, but request concurrency is bounded
    // by the provider's rate-limiting queue (RateLimitedSolanaRpcFactory), mirroring the EVM provider layer.
    const eventsWithSlots = await Promise.all(
      filteredSignatures.map(async (signatureTransaction) => {
        const events = await this.readEventsFromSignature(signatureTransaction.signature, options.commitment);
        return events.map((event) => ({
          ...event,
          confirmationStatus: signatureTransaction.confirmationStatus,
          blockTime: signatureTransaction.blockTime,
          signature: signatureTransaction.signature,
          slot: signatureTransaction.slot,
        }));
      })
    );
    return eventsWithSlots.flat();
  }

  /**
   * Reads events from a transaction signature.
   *
   * @param txSignature - The transaction signature.
   * @param commitment - Commitment level.
   * @returns A promise that resolves to an array of events.
   */
  async readEventsFromSignature(txSignature: Signature, commitment: Commitment = "confirmed") {
    const txResult = await this.rpc
      .getTransaction(txSignature, { commitment, maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();

    return this.processEventFromTx(txResult);
  }

  /**
   * Processes events from a transaction.
   *
   * @param txResult - The transaction result.
   * @returns A promise that resolves to an array of events with their data and name.
   */
  private processEventFromTx(txResult?: GetTransactionReturnType): ({ program: Address } & RawDecodedEvent)[] {
    if (!isDefined(txResult) || isDefined(txResult.meta?.err)) return [];
    const events: ({ program: Address } & RawDecodedEvent)[] = [];

    const accountKeys = txResult.transaction.message.accountKeys;
    const messageAccountKeys = [...accountKeys];
    // Writable accounts come first, then readonly.
    // See https://docs.anza.xyz/proposals/versioned-transactions#new-transaction-format
    messageAccountKeys.push(...(txResult?.meta?.loadedAddresses?.writable ?? []));
    messageAccountKeys.push(...(txResult?.meta?.loadedAddresses?.readonly ?? []));

    for (const ixBlock of txResult.meta?.innerInstructions ?? []) {
      for (const ix of ixBlock.instructions) {
        const ixProgramId = messageAccountKeys[ix.programIdIndex];
        const singleIxAccount = ix.accounts.length === 1 ? messageAccountKeys[ix.accounts[0]] : undefined;
        if (
          ixProgramId !== undefined &&
          singleIxAccount !== undefined &&
          this.programAddress === ixProgramId &&
          this.programEventAuthority === singleIxAccount
        ) {
          const ixData = bs58.decode(ix.data);
          // Only decode genuine Anchor CPI events. The instruction data of an emitted event is
          // prefixed with the Anchor event discriminator; requiring it prevents an arbitrary CPI
          // into the program (with the event authority as its sole account and crafted trailing
          // bytes) from being decoded as a forged event.
          if (
            ixData.length < ANCHOR_CPI_EVENT_DISCRIMINATOR.length ||
            !ANCHOR_CPI_EVENT_DISCRIMINATOR.equals(Buffer.from(ixData.slice(0, ANCHOR_CPI_EVENT_DISCRIMINATOR.length)))
          ) {
            continue;
          }
          // Skip the 8-byte Anchor event discriminator and decode the remaining event payload.
          const eventData = Buffer.from(ixData.slice(8)).toString("base64");
          events.push({ program: this.programAddress, ...decodeEvent(this.idl, eventData) });
        }
      }
    }

    return events;
  }

  /**
   * Finds all FundsDeposited events for a given transaction signature.
   *
   * @param originChainId - The chain ID where the deposit originated.
   * @param txSignature - The transaction signature to search for events.
   * @param commitment - Optional commitment level for the transaction query.
   * @returns A promise that resolves to an array of deposit events for the transaction, or undefined if none found.
   */
  public async getDepositEventsFromSignature(
    originChainId: number,
    txSignature: Signature,
    commitment: Commitment = "confirmed"
  ): Promise<DepositEventFromSignature[] | undefined> {
    assert(chainIsSvm(originChainId), `Origin chain ${originChainId} is not an SVM chain`);

    const [events, txDetails] = await Promise.all([
      this.readEventsFromSignature(txSignature, commitment),
      this.rpc
        .getTransaction(txSignature, {
          commitment,
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send(),
    ]);

    // Filter for FundsDeposited events only
    const depositEvents = events?.filter(
      (event): event is { program: Address } & DecodedEvent<"FundsDeposited"> =>
        event.name === SVMEventNames.FundsDeposited
    );
    if (!txDetails || !depositEvents?.length) {
      return;
    }

    return depositEvents.map((event) => ({
      ...depositFromEvent(event.data, originChainId, { slot: txDetails.slot, signature: txSignature }),
      depositTimestamp: Number(txDetails.blockTime),
    }));
  }

  /**
   * Finds all FilledRelay events for a given transaction signature.
   *
   * @param destinationChainId - The destination chain ID (must be an SVM chain).
   * @param txSignature - The transaction signature to search for events.
   * @returns A promise that resolves to an array of fill events for the transaction, or undefined if none found.
   */
  public async getFillEventsFromSignature(
    destinationChainId: number,
    txSignature: Signature,
    commitment: Commitment = "confirmed"
  ): Promise<FillEventFromSignature[] | undefined> {
    assert(chainIsSvm(destinationChainId), `Destination chain ${destinationChainId} is not an SVM chain`);

    // Find all events from the transaction signature and get transaction details
    const [events, txDetails] = await Promise.all([
      this.readEventsFromSignature(txSignature, commitment),
      this.rpc
        .getTransaction(txSignature, {
          commitment,
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send(),
    ]);

    // Filter for FilledRelay events only
    const fillEvents = events?.filter(
      (event): event is { program: Address } & DecodedEvent<"FilledRelay"> => event.name === SVMEventNames.FilledRelay
    );

    if (!txDetails || !fillEvents?.length) {
      return;
    }

    return fillEvents.map((event) => ({
      ...fillFromEvent(event.data, destinationChainId, { slot: txDetails.slot, signature: txSignature }),
      fillTimestamp: Number(txDetails.blockTime),
    }));
  }

  public getProgramAddress(): Address {
    return this.programAddress;
  }

  public getRpc(): SVMProvider {
    return this.rpc;
  }
}
