import { getDeployedAddress, SvmSpokeIdl } from "@across-protocol/contracts";
import { getSolanaChainId } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { BorshEventCoder, utils } from "@coral-xyz/anchor";
import web3, {
  Address,
  Commitment,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  RpcTransport,
  Signature
} from "@solana/web3-v2.js";
import { EventData, EventName, EventWithData } from "./types";
import { getEventName, parseEventData } from "./utils/events";
import { isDevnet } from "./utils/helpers";

// Note: Type assumes default JSON encoding. Using different encoding options (e.g. base58) would result in incompatible
// return types.
type GetTransactionReturnType = ReturnType<GetTransactionApi["getTransaction"]>;
type GetSignaturesForAddressConfig = Parameters<GetSignaturesForAddressApi["getSignaturesForAddress"]>[1];
type GetSignaturesForAddressTransaction = ReturnType<GetSignaturesForAddressApi["getSignaturesForAddress"]>[number];
type GetSignaturesForAddressApiResponse = readonly GetSignaturesForAddressTransaction[];

export class SvmSpokeEventsClient {
  private rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>;
  private svmSpokeAddress: Address;

  /**
   * Private constructor. Use the async create() method to instantiate.
   */
  private constructor(rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>, svmSpokeAddress: Address) {
    this.rpc = rpc;
    this.svmSpokeAddress = svmSpokeAddress;
  }

  /**
   * Factory method to asynchronously create an instance of SvmSpokeEventsClient.
   */
  public static async create(
    rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>
  ): Promise<SvmSpokeEventsClient> {
    const isTestnet = await isDevnet(rpc);
    const programId = getDeployedAddress("SvmSpoke", getSolanaChainId(isTestnet ? "devnet" : "mainnet").toString());
    if (!programId) throw new Error("Program not found");
    return new SvmSpokeEventsClient(rpc, web3.address(programId));
  }

  /**
   * Queries events for the SvmSpoke program filtered by event name.
   *
   * @param eventName - The name of the event to filter by.
   * @param fromSlot - Optional starting slot.
   * @param toSlot - Optional ending slot.
   * @param options - Options for fetching signatures.
   * @param finality - Commitment level.
   * @returns A promise that resolves to an array of events matching the eventName.
   */
  public async queryEvents<T extends EventData>(
    eventName: EventName,
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" },
  ): Promise<EventWithData<T>[]> {
    const events = await this.queryAllEvents(fromSlot, toSlot, options);
    return events.filter((event) => event.name === eventName) as EventWithData<T>[];
  }

  /**
   * Queries all events for a specific program.
   *
   * @param program - The program address.
   * @param anchorIdl - The IDL describing the program events.
   * @param fromSlot - Optional starting slot.
   * @param toSlot - Optional ending slot.
   * @param options - Options for fetching signatures.
   * @param commitment - Commitment level.
   * @returns A promise that resolves to an array of all events with additional metadata.
   */
  private async queryAllEvents(
    fromSlot?: bigint,
    toSlot?: bigint,
    options: GetSignaturesForAddressConfig = { limit: 1000, commitment: "confirmed" }
  ): Promise<EventWithData<EventData>[]> {
    const allSignatures: GetSignaturesForAddressTransaction[] = [];
    let hasMoreSignatures = true;
    let currentOptions = options;

    while (hasMoreSignatures) {
      const signatures: GetSignaturesForAddressApiResponse = await this.rpc
        .getSignaturesForAddress(this.svmSpokeAddress, currentOptions)
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
   * @param programId - The program address.
   * @param programIdl - The program IDL.
   * @param commitment - Commitment level.
   * @returns A promise that resolves to an array of events.
   */
  private async readEventsFromSignature(
    txSignature: Signature,
    commitment: Commitment = "confirmed"
  ) {
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
   * @param programId - The program address.
   * @param programIdl - The program IDL.
   * @returns A promise that resolves to an array of events with their data and name.
   */
  private async processEventFromTx(
    txResult: GetTransactionReturnType
  ): Promise<{ program: Address; data: EventData; name: EventName }[]> {
    if (!txResult) return [];

    const eventAuthorities: Map<string, Address> = new Map();
    const events: { program: Address; data: EventData; name: EventName }[] = [];

    // Derive the event authority PDA.
    const [pda] = await web3.getProgramDerivedAddress({
      programAddress: this.svmSpokeAddress,
      seeds: ["__event_authority"],
    });
    eventAuthorities.set(this.svmSpokeAddress.toString(), pda);

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
          this.svmSpokeAddress === ixProgramId &&
          eventAuthorities.get(ixProgramId.toString()) === singleIxAccount
        ) {
          const ixData = utils.bytes.bs58.decode(ix.data);
          // Skip the first 8 bytes (assumed header) and encode the rest.
          const eventData = utils.bytes.base64.encode(Buffer.from(new Uint8Array(ixData).slice(8)));
          const event = new BorshEventCoder(SvmSpokeIdl).decode(eventData);
          if (!event?.name) throw new Error("Event name is undefined");
          const name = getEventName(event.name);
          events.push({
            program: this.svmSpokeAddress,
            data: parseEventData(event?.data),
            name,
          });
        }
      }
    }

    return events;
  }
}
