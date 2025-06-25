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
import { bs58, chainIsSvm, getMessageHash, toAddressType } from "../../utils";
import { EventName, EventWithData, SVMProvider } from "./types";
import { decodeEvent, isDevnet } from "./utils";
import { Deposit, DepositWithTime, Fill, FillWithTime } from "../../interfaces";
import { unwrapEventData } from "./";
import assert from "assert";

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
  public async queryEvents(
    eventName: EventName,
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" }
  ): Promise<EventWithData[]> {
    const events = await this.queryAllEvents(fromSlot, toSlot, options);
    return events.filter((event) => event.name === eventName) as EventWithData[];
  }

  /**
   * Queries events for the provided derived address at instantiation filtered by event name.
   *
   * @param eventName - The name of the event to filter by.
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
  ): Promise<EventWithData[]> {
    const events = await this.queryAllEvents(fromSlot, toSlot, options, derivedAddress);
    return events.filter((event) => event.name === eventName) as EventWithData[];
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
  ): Promise<EventWithData[]> {
    const addressToQuery = derivedAddress || this.programAddress;
    const allSignatures: GetSignaturesForAddressTransaction[] = [];
    let hasMoreSignatures = true;
    let currentOptions = options;

    while (hasMoreSignatures) {
      const signatures: GetSignaturesForAddressApiResponse = await this.rpc
        .getSignaturesForAddress(addressToQuery!, currentOptions)
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

    // Fetch events for all signatures in parallel.
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
      .getTransaction(txSignature, { commitment, maxSupportedTransactionVersion: 0 })
      .send();

    if (txResult === null) return [];
    return this.processEventFromTx(txResult);
  }

  /**
   * Processes events from a transaction.
   *
   * @param txResult - The transaction result.
   * @returns A promise that resolves to an array of events with their data and name.
   */
  private processEventFromTx(txResult: GetTransactionReturnType): { program: Address; data: unknown; name: string }[] {
    if (!txResult) return [];
    const events: { program: Address; data: unknown; name: string }[] = [];

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
          // Skip the first 8 bytes (assumed header) and encode the rest.
          const eventData = Buffer.from(ixData.slice(8)).toString("base64");
          const { name, data } = decodeEvent(this.idl, eventData);
          events.push({ program: this.programAddress, name, data });
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
        })
        .send(),
    ]);

    // Filter for FundsDeposited events only
    const depositEvents = events?.filter((event) => event?.name === "FundsDeposited");

    if (!txDetails || !depositEvents?.length) {
      return;
    }

    return events.map((event) => {
      const unwrappedEventArgs = unwrapEventData(event as Record<string, unknown>, ["depositId"]) as Record<
        "data",
        Deposit
      > &
        Record<
          "data",
          {
            depositor: string;
            recipient: string;
            exclusiveRelayer: string;
            inputToken: string;
            outputToken: string;
          }
        >;

      return {
        ...unwrappedEventArgs.data,
        depositor: toAddressType(unwrappedEventArgs.data.depositor, unwrappedEventArgs.data.originChainId),
        recipient: toAddressType(unwrappedEventArgs.data.recipient, unwrappedEventArgs.data.destinationChainId),
        exclusiveRelayer: toAddressType(
          unwrappedEventArgs.data.exclusiveRelayer,
          unwrappedEventArgs.data.destinationChainId
        ),
        inputToken: toAddressType(unwrappedEventArgs.data.inputToken, unwrappedEventArgs.data.originChainId),
        outputToken: toAddressType(unwrappedEventArgs.data.outputToken, unwrappedEventArgs.data.destinationChainId),
        depositTimestamp: Number(txDetails.blockTime),
        originChainId,
        messageHash: getMessageHash(unwrappedEventArgs.data.message),
        blockNumber: Number(txDetails.slot),
        txnIndex: 0,
        txnRef: txSignature,
        logIndex: 0,
      } satisfies DepositEventFromSignature;
    });
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
        })
        .send(),
    ]);

    // Filter for FilledRelay events only
    const fillEvents = events?.filter((event) => event?.name === "FilledRelay");

    if (!txDetails || !fillEvents?.length) {
      return;
    }

    return fillEvents.map((event) => {
      const unwrappedEventData = unwrapEventData(event as Record<string, unknown>) as Record<"data", Fill> &
        Record<
          "data",
          {
            depositor: string;
            recipient: string;
            exclusiveRelayer: string;
            inputToken: string;
            outputToken: string;
          }
        >;

      return {
        ...unwrappedEventData.data,
        depositor: toAddressType(unwrappedEventData.data.depositor, unwrappedEventData.data.originChainId),
        recipient: toAddressType(unwrappedEventData.data.recipient, unwrappedEventData.data.destinationChainId),
        exclusiveRelayer: toAddressType(
          unwrappedEventData.data.exclusiveRelayer,
          unwrappedEventData.data.destinationChainId
        ),
        inputToken: toAddressType(unwrappedEventData.data.inputToken, unwrappedEventData.data.originChainId),
        outputToken: toAddressType(unwrappedEventData.data.outputToken, unwrappedEventData.data.destinationChainId),
        fillTimestamp: Number(txDetails.blockTime),
        blockNumber: Number(txDetails.slot),
        txnRef: txSignature,
        txnIndex: 0,
        logIndex: 0,
        destinationChainId,
      } satisfies FillEventFromSignature;
    });
  }

  public getProgramAddress(): Address {
    return this.programAddress;
  }

  public getRpc(): SVMProvider {
    return this.rpc;
  }
}
