import {
  PUBLIC_NETWORKS,
  TOKEN_SYMBOLS_MAP,
  CCTP_NO_DOMAIN,
  PRODUCTION_NETWORKS,
  TEST_NETWORKS,
} from "@across-protocol/constants";
import { BigNumber, Contract, ethers } from "ethers";
import { isDefined } from "./TypeGuards";
import { EventSearchConfig, paginatedEventQuery } from "./EventUtils";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import axios from "axios";
import { Address, EvmAddress } from "./AddressUtils";
import { forEachAsync } from "./ArrayUtils";
import { chainIsProd } from "./NetworkUtils";
import { bnZero } from "./BigNumberUtils";

export type CCTPAPIGetAttestationResponse = { status: string; attestation: string; cctpVersion: number };
export type CCTPV2APIAttestation = {
  status: string;
  attestation: string;
  message: string;
  eventNonce: string;
  cctpVersion: number;
  decodedMessage: {
    recipient: string;
    destinationDomain: number;
    decodedMessageBody: {
      amount: string;
      mintRecipient: string;
      messageSender: string;
    };
  };
};
export type CCTPV2APIGetAttestationResponse = { messages: CCTPV2APIAttestation[] };

export type CCTPMessageStatus = "finalized" | "ready" | "pending";

/**
 * @notice Converts an ETH Address string to a 32-byte hex string.
 * @param address The address to convert.
 * @returns The 32-byte hex string representation of the address - required for CCTP messages.
 */
export function cctpAddressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

/**
 * Converts a 32-byte hex string with padding to a standard ETH address.
 * @param bytes32 The 32-byte hex string to convert.
 * @returns The ETH address representation of the 32-byte hex string.
 */
export function cctpBytes32ToAddress(bytes32: string): string {
  // Grab the last 20 bytes of the 32-byte hex string
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(bytes32, 12));
}

/**
 * @notice Returns the CCTP domain for a given chain ID. Throws if the chain ID is not a CCTP domain.
 * @param chainId
 * @returns CCTP Domain ID
 */
export function getCctpDomainForChainId(chainId: number): number {
  const cctpDomain = PUBLIC_NETWORKS[chainId]?.cctpDomain;
  if (!isDefined(cctpDomain) || cctpDomain === CCTP_NO_DOMAIN) {
    throw new Error(`No CCTP domain found for chainId: ${chainId}`);
  }
  return cctpDomain;
}

export function getCctpDestinationChainFromDomain(domain: number, productionNetworks: boolean): number {
  if (domain === CCTP_NO_DOMAIN) {
    throw new Error("Cannot input CCTP_NO_DOMAIN to getCctpDestinationChainFromDomain");
  }
  // Test and Production networks use the same CCTP domain, so we need to use the flag passed in to
  // determine whether to use the Test or Production networks.
  const networks = productionNetworks ? PRODUCTION_NETWORKS : TEST_NETWORKS;
  const otherNetworks = productionNetworks ? TEST_NETWORKS : PRODUCTION_NETWORKS;
  const chainId = Object.keys(networks).find(
    (key) => networks[Number(key)].cctpDomain.toString() === domain.toString()
  );
  if (!isDefined(chainId)) {
    const chainId = Object.keys(otherNetworks).find(
      (key) => otherNetworks[Number(key)].cctpDomain.toString() === domain.toString()
    );
    if (!isDefined(chainId)) {
      throw new Error(`No chainId found for domain: ${domain}`);
    }
    return parseInt(chainId);
  }
  return parseInt(chainId);
}

/**
 * @notice A map of transaction hashes to CCTP V2 destination domains.
 */
interface CctpV2DepositForBurnEventMap {
  [txnHash: string]: number;
}
/**
 * Return all deposit for burn transaction hashes along wtih corresponding destination domains that were
 * created on the source chain.
 * @param srcTokenMessenger CCTP V2 TokenMessenger contract on the source chain that we'll query for
 * DepositForBurn events.
 * @param sourceChainId Chain ID where the deposit for burn events originated.
 * @param _senderAddresses Addresses that initiated the `DepositForBurn` events.
 * @param sourceEventSearchConfig Event search filter on origin chain.
 * @returns A map of transaction hashes to destination domains.
 */
export async function getCctpV2DepositForBurnTxnHashes(
  srcTokenMessenger: Contract,
  sourceChainId: number,
  _senderAddresses: Address[],
  sourceEventSearchConfig: EventSearchConfig
): Promise<CctpV2DepositForBurnEventMap> {
  const senderAddresses = _senderAddresses.map((address) => address.toNative());
  const eventFilterParams = [TOKEN_SYMBOLS_MAP.USDC.addresses[sourceChainId], undefined, senderAddresses];
  const eventFilter = srcTokenMessenger.filters.DepositForBurn(...eventFilterParams);
  const depositForBurnEvents = await paginatedEventQuery(srcTokenMessenger, eventFilter, sourceEventSearchConfig);
  const depositForBurnEventsMap: CctpV2DepositForBurnEventMap = {};
  depositForBurnEvents.forEach((e) => {
    depositForBurnEventsMap[e.transactionHash] = e.args.destinationDomain;
  });
  return depositForBurnEventsMap;
}

interface CctpV2ReadyToFinalizeDeposits {
  txnHash: string;
  destinationChainId: number;
  attestationData: CCTPV2APIAttestation;
}

/**
 * @notice Returns the statuses of all deposit for burn events on the source chain.
 * @param depositForBurnEvents A map of transaction hashes to CCTP V2 destination domains.
 * @param sourceChainId Chain ID where the deposit for burn events originated.
 * @param senderAndRecipientAddresses Addresses that initiated the `DepositForBurn` events.
 * @returns A map of transaction hashes to destination domains.
 * Returns:
 * - pendingDepositTxnHashes: Transaction hashes of deposits that are pending attestation.
 * - finalizedDepositTxnHashes: Transaction hashes of deposits that have been finalized.
 * - readyToFinalizeDeposits: Transaction hashes of deposits that are ready to be finalized.
 */
export async function getCctpV2DepositForBurnStatuses(
  depositForBurnEvents: CctpV2DepositForBurnEventMap,
  sourceChainId: number,
  destinationChainMessengerContracts: { [chainId: number]: Contract },
  senderAndRecipientAddresses: Address[]
): Promise<{
  pendingDepositTxnHashes: string[];
  finalizedDepositTxnHashes: { txnHash: string; destinationChainId: number }[];
  readyToFinalizeDeposits: CctpV2ReadyToFinalizeDeposits[];
}> {
  // Fetch attestations for all deposit burn event transaction hashes. Note, some events might share the same
  // transaction hash, so only fetch attestations for unique transaction hashes.
  const uniqueTxHashes = Object.keys(depositForBurnEvents);
  const attestationResponses = await fetchCctpV2Attestations(uniqueTxHashes, sourceChainId);

  // Categorize deposits based on status:
  const pendingDepositTxnHashes: string[] = [];
  const finalizedDepositTxnHashes: { txnHash: string; destinationChainId: number }[] = [];
  const readyToFinalizeDeposits: {
    txnHash: string;
    destinationChainId: number;
    attestationData: CCTPV2APIAttestation;
  }[] = [];
  await forEachAsync(
    Object.entries(attestationResponses),
    async ([txnHash, attestations]: [string, CCTPV2APIGetAttestationResponse]) => {
      await forEachAsync(attestations.messages, async (attestation: CCTPV2APIAttestation) => {
        if (attestation.cctpVersion !== 2) {
          return;
        }
        // API has not produced an attestation for this deposit yet:
        if (getPendingAttestationStatus(attestation) === "pending") {
          pendingDepositTxnHashes.push(txnHash);
          return;
        }

        // Filter out events where the sender or recipient is not one of our expected addresses.
        const recipient = attestation.decodedMessage.decodedMessageBody.mintRecipient;
        const sender = attestation.decodedMessage.decodedMessageBody.messageSender;
        if (
          !senderAndRecipientAddresses.some(
            (address) => address.eq(EvmAddress.from(recipient)) || address.eq(EvmAddress.from(sender))
          )
        ) {
          return;
        }

        // If API attestationstatus  is "complete", then we need to check whether it has been already finalized:
        const destinationChainId = getCctpDestinationChainFromDomain(
          attestation.decodedMessage.destinationDomain,
          chainIsProd(sourceChainId)
        );
        if (!isDefined(destinationChainMessengerContracts[destinationChainId])) {
          return;
        }
        const destinationMessageTransmitter = destinationChainMessengerContracts[destinationChainId];
        const processed = await hasCCTPMessageBeenProcessedEvm(attestation.eventNonce, destinationMessageTransmitter);
        if (processed) {
          finalizedDepositTxnHashes.push({ txnHash, destinationChainId });
        } else {
          readyToFinalizeDeposits.push({ txnHash, destinationChainId, attestationData: attestation });
        }
      });
    }
  );
  return { pendingDepositTxnHashes, finalizedDepositTxnHashes, readyToFinalizeDeposits };
}

/**
 * @notice Returns calldata needed to submit finalization transaction on destination chain for deposit for burn event.
 * @param readyToFinalizeDeposit Contains destinationChainId, attestation data, and source chain transaction hash.
 * @returns returns address of contract to call on destination chain and calldata.
 */
export async function getCctpV2ReceiveMessageCallData(
  readyToFinalizeDeposit: CctpV2ReadyToFinalizeDeposits,
  destinationMessageTransmitter: Contract
): Promise<TransactionRequest> {
  return (await destinationMessageTransmitter.populateTransaction.receiveMessage(
    readyToFinalizeDeposit.attestationData.message,
    readyToFinalizeDeposit.attestationData.attestation
  )) as TransactionRequest;
}

export async function fetchCctpV2Attestations(
  depositForBurnTxnHashes: string[],
  sourceChainId: number
): Promise<{ [sourceTxnHash: string]: CCTPV2APIGetAttestationResponse }> {
  // For v2, we fetch an API response for every txn hash we have. API returns an array of both v1 and v2 attestations
  const sourceDomainId = getCctpDomainForChainId(sourceChainId);
  const isMainnet = chainIsProd(sourceChainId);

  // Circle rate limit is 35 requests / second. To avoid getting banned, batch calls into chunks with 1 second delay between chunks
  // For v2, this is actually required because we don't know if message is finalized or not before hitting the API. Therefore as our
  // CCTP v2 list of chains grows, we might require more than 35 calls here to fetch all attestations
  const attestationResponses: { [sourceTxnHash: string]: CCTPV2APIGetAttestationResponse } = {};
  const chunkSize = 8;
  for (let i = 0; i < depositForBurnTxnHashes.length; i += chunkSize) {
    const chunk = depositForBurnTxnHashes.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map(async (txHash) => {
        const attestations = await _fetchAttestationsForTxn(sourceDomainId, txHash, isMainnet);

        // If multiple deposit for burn events, there will be multiple attestations.
        attestationResponses[txHash] = attestations;
      })
    );

    if (i + chunkSize < depositForBurnTxnHashes.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return attestationResponses;
}

// Returns both v1 and v2 attestations
async function _fetchAttestationsForTxn(
  sourceDomainId: number,
  transactionHash: string,
  isMainnet: boolean
): Promise<CCTPV2APIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPV2APIGetAttestationResponse>(
    `https://iris-api${
      isMainnet ? "" : "-sandbox"
    }.circle.com/v2/messages/${sourceDomainId}?transactionHash=${transactionHash}`
  );

  return httpResponse.data;
}

export function getPendingAttestationStatus(
  attestation: CCTPV2APIAttestation | CCTPAPIGetAttestationResponse
): CCTPMessageStatus {
  if (!isDefined(attestation.attestation)) {
    return "pending";
  } else {
    return attestation.status === "pending_confirmations" || attestation.attestation === "PENDING"
      ? "pending"
      : "ready";
  }
}

export async function hasCCTPMessageBeenProcessedEvm(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}