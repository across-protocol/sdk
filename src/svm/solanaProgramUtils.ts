import { BorshEventCoder, Idl, utils } from "@coral-xyz/anchor";
import web3, {
  Address,
  Commitment,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  RpcTransport,
  Signature,
} from "@solana/web3-v2.js";
import { BridgedToHubPoolEvent, ClaimedRelayerRefundEvent, EmergencyDeletedRootBundleEvent, EnabledDepositRouteEvent, EventData, EventName, ExecutedRelayerRefundRootEvent, FilledRelayEvent, FundsDepositedEvent, PausedDepositsEvent, PausedFillsEvent, RelayedRootBundleEvent, RequestedSlowFillEvent, SetXDomainAdminEvent, SVMEventNames, TokensBridgedEvent } from "./types";

type GetTransactionReturnType = ReturnType<GetTransactionApi["getTransaction"]>;

type GetSignaturesForAddressConfig = Parameters<GetSignaturesForAddressApi["getSignaturesForAddress"]>[1];

type GetSignaturesForAddressTransaction = ReturnType<GetSignaturesForAddressApi["getSignaturesForAddress"]>[number];

type GetSignaturesForAddressApiResponse = readonly GetSignaturesForAddressTransaction[];

/**
 * Reads all events for a specific program.
 */
export async function readProgramEvents(
  rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>,
  program: Address,
  anchorIdl: Idl,
  finality: Commitment = "confirmed",
  options: GetSignaturesForAddressConfig = { limit: 1000 }
) {
  const allSignatures: GetSignaturesForAddressTransaction[] = [];

  let hasMoreSignatures = true;
  while (hasMoreSignatures) {
    const signatures: GetSignaturesForAddressApiResponse = await rpc.getSignaturesForAddress(program, options).send();
    allSignatures.push(...signatures);

    // Update options for the next batch. Set before to the last fetched signature.
    if (signatures.length > 0) {
      options = { ...options, before: signatures[signatures.length - 1].signature };
    }

    hasMoreSignatures = Boolean(options.limit && signatures.length === options.limit);
  }

  // Fetch events for all signatures in parallel
  const eventsWithSlots = await Promise.all(
    allSignatures.map(async (signatureTransaction) => {
      const events = await readEvents(rpc, signatureTransaction.signature, program, anchorIdl, finality);

      return events.map((event) => ({
        ...event,
        confirmationStatus: signatureTransaction.confirmationStatus || "Unknown",
        blockTime: signatureTransaction.blockTime || 0,
        signature: signatureTransaction.signature,
        slot: signatureTransaction.slot,
        name: event.name || "Unknown",
      }));
    })
  );
  return eventsWithSlots.flat();
}

/**
 * Reads events from a transaction.
 */
export async function readEvents(
  rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>,
  txSignature: Signature,
  programId: Address,
  programIdl: Idl,
  commitment: Commitment = "confirmed"
) {
  const txResult = await rpc.getTransaction(txSignature, { commitment, maxSupportedTransactionVersion: 0 }).send();

  if (txResult === null) return [];

  return processEventFromTx(txResult, programId, programIdl);
}

/**
 * Processes events from a transaction.
 */
async function processEventFromTx(
  txResult: GetTransactionReturnType,
  programId: Address,
  programIdl: Idl
): Promise<{ program: Address; data: EventData; name: string }[]> {
  if (!txResult) return [];
  const eventAuthorities: Map<string, Address> = new Map();
  const events: { program: Address; data: EventData; name: string }[] = [];
  const [pda] = await web3.getProgramDerivedAddress({ programAddress: programId, seeds: ["__event_authority"] });
  eventAuthorities.set(programId, pda);

  const accountKeys = txResult.transaction.message.accountKeys;
  const messageAccountKeys = [...accountKeys];
  // Order matters here. writable accounts must be processed before readonly accounts.
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
        programId == ixProgramId &&
        eventAuthorities.get(ixProgramId.toString()) == singleIxAccount
      ) {
        const ixData = utils.bytes.bs58.decode(ix.data);
        const eventData = utils.bytes.base64.encode(Buffer.from(new Uint8Array(ixData).slice(8)));
        const event = new BorshEventCoder(programIdl).decode(eventData);
        const name = getEventName(event?.name);
        events.push({
          program: programId,
          data: mapEventData(event?.data, name),
          name,
        });
      }
    }
  }

  return events;
}



function getEventName(rawName?: string): EventName {
  if (!rawName) throw new Error("Raw name is undefined");
  if (Object.values(SVMEventNames).some((name) => rawName.includes(name))) return rawName as EventName;
  throw new Error(`Unknown event name: ${rawName}`);
}

function mapEventData(eventData: any, name: EventName): EventData {
  switch (name) {
    case "FilledRelay":
      return eventData as FilledRelayEvent;
    case "FundsDeposited":
      return eventData as FundsDepositedEvent;
    case "BridgedToHubPool":
      return eventData as BridgedToHubPoolEvent;
    case "TokensBridged":
      return eventData as TokensBridgedEvent;
    case "ExecutedRelayerRefundRoot":
      return eventData as ExecutedRelayerRefundRootEvent;
    case "RelayedRootBundle":
      return eventData as RelayedRootBundleEvent;
    case "PausedDeposits":
      return eventData as PausedDepositsEvent;
    case "PausedFills":
      return eventData as PausedFillsEvent;
    case "SetXDomainAdmin":
      return eventData as SetXDomainAdminEvent;
    case "EnabledDepositRoute":
      return eventData as EnabledDepositRouteEvent;
    case "EmergencyDeletedRootBundle":
      return eventData as EmergencyDeletedRootBundleEvent;
    case "RequestedSlowFill":
      return eventData as RequestedSlowFillEvent;
    case "ClaimedRelayerRefund":
      return eventData as ClaimedRelayerRefundEvent;
    default:
      throw new Error(`Unknown event name: ${name}`);
  }
}
