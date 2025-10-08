import { PUBLIC_NETWORKS, CCTP_NO_DOMAIN, PRODUCTION_NETWORKS, TEST_NETWORKS } from "@across-protocol/constants";
import { BigNumber, ethers } from "ethers";

import { Log } from "@ethersproject/abstract-provider";
import { isDefined } from "./TypeGuards";
import axios from "axios";
import { chainIsProd } from "./NetworkUtils";
import assert from "assert";
import { bnZero } from "./BigNumberUtils";
/** ********************************************************************************************************************
 *
 * CONSTANTS
 *
 ******************************************************************************************************************* **/

export type CCTPMessageStatus = "finalized" | "ready" | "pending";
export const CCTPV2_FINALITY_THRESHOLD_STANDARD = 2000;
export const CCTPV2_FINALITY_THRESHOLD_FAST = 1000;
/** ********************************************************************************************************************
 *
 * CCTP SMART CONTRACT EVENT TYPES
 *
 ******************************************************************************************************************* **/

// Params shared by Message and DepositForBurn events.
type CommonMessageData = {
  // `cctpVersion` is nuanced. cctpVersion returned from API are 1 or 2 (v1 and v2 accordingly). The bytes responsible for a version within the message itself though are 0 or 1 (v1 and v2 accordingly) :\
  cctpVersion: number;
  sourceDomain: number;
  destinationDomain: number;
  sender: string;
  recipient: string;
  messageHash: string;
  messageBytes: string;
  nonce: number; // This nonce makes sense only for v1 events, as it's emitted on src chain send
  nonceHash: string;
};
type DepositForBurnMessageData = CommonMessageData & { amount: string; mintRecipient: string; burnToken: string };
type CommonMessageEvent = CommonMessageData & { log: Log };
type DepositForBurnMessageEvent = DepositForBurnMessageData & { log: Log };
type CCTPMessageEvent = CommonMessageEvent | DepositForBurnMessageEvent;

const CCTP_MESSAGE_SENT_TOPIC_HASH = ethers.utils.id("MessageSent(bytes)");
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1 = ethers.utils.id(
  "DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)"
);
const CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2 = ethers.utils.id(
  "DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)"
);

/** ********************************************************************************************************************
 *
 * CCTP API TYPES
 *
 ******************************************************************************************************************* **/

// CCTP V1 /attestations/{messageHash} response
type CCTPV1APIGetAttestationResponse = { status: string; attestation: string };

// CCTP V2 /burn/USDC/fees/{sourceDomainId}/{destDomainId} response
type CCTPV2APIGetFeesResponse = { finalityThreshold: number; minimumFee: number }[];

// CCTP V2 /fastBurn/USDC/allowance response
type CCTPV2APIGetFastBurnAllowanceResponse = { allowance: number };

// CCTP V2 /messages/{sourceDomainId} response
type CCTPV2APIAttestation = {
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
type CCTPV2APIGetAttestationResponse = { messages: CCTPV2APIAttestation[] };

/** ********************************************************************************************************************
 *
 * Exported functions and constants:
 *
 ******************************************************************************************************************* **/

export type AttestedCCTPMessage = CCTPMessageEvent & { status: CCTPMessageStatus; attestation?: string };
export type AttestedCCTPDeposit = DepositForBurnMessageEvent & { status: CCTPMessageStatus; attestation?: string };

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

/**
 * @notice Returns the chain ID for a given CCTP domain. Inverse functionof `getCctpDomainForChainId()`. However,
 * since CCTP Domains are shared between production and test networks, we need to use the `productionNetworks` flag
 * to determine whether to return the production  or test network chain ID.
 * @param domain CCTP domain ID.
 * @param productionNetworks Whether to return the production or test network chain ID.
 * @returns Chain ID.
 */
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
 * @notice Typeguard. Returns whether the event is a CCTP deposit for burn event. Should work for V1 and V2
 * @param event CCTP message event.
 * @returns True if the event is a CCTP V1 deposit for burn event.
 */
export function isDepositForBurnEvent(event: CCTPMessageEvent): event is DepositForBurnMessageEvent {
  return "amount" in event && "mintRecipient" in event && "burnToken" in event;
}

/**
 * @notice Fetches CCTP V2 attestations for a given list of transaction hashes. If a transaction hash
 * contains multiple CCTP messages, this will return an object where each key is a transaction hash and
 * a value is an array of attestations.
 * @param depositForBurnTxnHashes List of transaction hashes to fetch attestations for.
 * @param sourceChainId Source chain ID of the transaction hashes.
 * @returns Object with transaction hashes as keys and CCTP V2 attestations as values.
 */
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
  const chunkSize = process.env.CCTP_API_REQUEST_CHUNK_SIZE ? parseInt(process.env.CCTP_API_REQUEST_CHUNK_SIZE) : 8;
  for (let i = 0; i < depositForBurnTxnHashes.length; i += chunkSize) {
    const chunk = depositForBurnTxnHashes.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map(async (txHash) => {
        const attestations = await fetchAttestationsForTxn(sourceDomainId, txHash, isMainnet);

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

/**
 * @notice Returns the status of a CCTP attestation.
 * @param attestation Attestation to get the status of.
 * @returns "finalized","pending" or "ready".
 */
export function getPendingAttestationStatus(
  attestation: CCTPV2APIAttestation | CCTPV1APIGetAttestationResponse
): CCTPMessageStatus {
  if (!isDefined(attestation.attestation)) {
    return "pending";
  } else {
    return attestation.status === "pending_confirmations" || attestation.attestation === "PENDING"
      ? "pending"
      : "ready";
  }
}

/**
 * @notice Checks if a CCTP message has been processed by a given contract.
 * @param nonceHash Nonce hash to check.
 * @param contract
 * @returns True if the message has been processed, false otherwise.
 */
export async function hasCCTPMessageBeenProcessedEvm(nonceHash: string, contract: ethers.Contract): Promise<boolean> {
  const resultingCall: BigNumber = await contract.callStatic.usedNonces(nonceHash);
  // If the resulting call is 1, the message has been processed. If it is 0, the message has not been processed.
  return (resultingCall ?? bnZero).toNumber() === 1;
}
/**
 * @notice Decodes the message data for a V1 `MessageSent` event.
 * @param message
 * @param isSvm
 * @returns Decoded message data.
 */
export function decodeCommonMessageDataV1(message: { data: string }, isSvm = false): CommonMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8))); // sourceDomain 4 bytes starting index 4
  const destinationDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(8, 12))); // destinationDomain 4 bytes starting index 8
  const nonce = BigNumber.from(ethers.utils.hexlify(messageBytesArray.slice(12, 20))).toNumber(); // nonce 8 bytes starting index 12
  const sender = ethers.utils.hexlify(messageBytesArray.slice(20, 52)); // sender	20	bytes32	32	Address of MessageTransmitter caller on source domain
  const recipient = ethers.utils.hexlify(messageBytesArray.slice(52, 84)); // recipient	52	bytes32	32	Address to handle message body on destination domain

  // V1 nonce hash is a simple hash of the nonce emitted in Deposit event with the source domain ID.
  const nonceHash = ethers.utils.keccak256(ethers.utils.solidityPack(["uint32", "uint64"], [sourceDomain, nonce]));

  return {
    cctpVersion: 1,
    sourceDomain,
    destinationDomain,
    sender,
    recipient,
    nonce,
    nonceHash,
    messageHash: ethers.utils.keccak256(messageBytes),
    messageBytes,
  };
}

/**
 * @notice Decodes the message data for a V1 `DepositForBurn` event.
 * @param message
 * @param isSvm
 * @returns Decoded message data.
 */
export function decodeDepositForBurnMessageDataV1(message: { data: string }, isSvm = false): DepositForBurnMessageData {
  // Source: https://developers.circle.com/stablecoins/message-format
  const commonDataV1 = decodeCommonMessageDataV1(message, isSvm);
  const messageBytes = isSvm ? message.data : ethers.utils.defaultAbiCoder.decode(["bytes"], message.data)[0];
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  // Values specific to `DepositForBurn`. These are values contained within `messageBody` bytes (the last of the message.data fields)
  const burnToken = ethers.utils.hexlify(messageBytesArray.slice(120, 152)); // burnToken 4 bytes32 32 Address of burned token on source domain
  const mintRecipient = ethers.utils.hexlify(messageBytesArray.slice(152, 184)); // mintRecipient 32 bytes starting index 152 (idx 36 of body after idx 116 which ends the header)
  const amount = ethers.utils.hexlify(messageBytesArray.slice(184, 216)); // amount 32 bytes starting index 184 (idx 68 of body after idx 116 which ends the header)
  const sender = ethers.utils.hexlify(messageBytesArray.slice(216, 248)); // sender 32 bytes starting index 216 (idx 100 of body after idx 116 which ends the header)

  return {
    ...commonDataV1,
    burnToken,
    amount: BigNumber.from(amount).toString(),
    // override sender and recipient from `DepositForBurn`-specific values. This is required because raw sender / recipient for a message like this
    // are CCTP's TokenMessenger contracts rather than the addrs sending / receiving tokens
    sender: sender,
    recipient: mintRecipient,
    mintRecipient,
  };
}

/**
 * @notice The maximum amount of USDC that can be sent using a fast transfer.
 * @param isMainnet Toggles whether to call CCTP API on mainnet or sandbox environment.
 * @returns USDC amount in units of USDC.
 * @link https://developers.circle.com/api-reference/cctp/all/get-fast-burn-usdc-allowance
 */
export async function getV2FastBurnAllowance(isMainnet: boolean): Promise<string> {
  const httpResponse = await axios.get<CCTPV2APIGetFastBurnAllowanceResponse>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/v2/fastBurn/USDC/allowance`
  );
  return httpResponse.data.allowance.toString();
}

/**
 * Returns the minimum transfer fees required for a transfer to be relayed. When calling depositForBurn(), the maxFee
 * parameter must be greater than or equal to the minimum fee.
 * @param sourceChainId The source chain ID of the transfer.
 * @param destinationChainId The destination chain ID of the transfer.
 * @param isMainnet Toggles whether to call CCTP API on mainnet or sandbox environment.
 * @returns The standard and fast transfer fees for the given source and destination chains.
 * @link https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees
 */
export async function getV2MinTransferFees(
  sourceChainId: number,
  destinationChainId: number
): Promise<{ standard: BigNumber; fast: BigNumber }> {
  const isMainnet = chainIsProd(destinationChainId);
  const sourceDomain = getCctpDomainForChainId(sourceChainId);
  const destinationDomain = getCctpDomainForChainId(destinationChainId);
  const endpoint = `https://iris-api${
    isMainnet ? "" : "-sandbox"
  }.circle.com/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`;
  const httpResponse = await axios.get<CCTPV2APIGetFeesResponse>(endpoint);
  const standardFee = httpResponse.data.find((fee) => fee.finalityThreshold === CCTPV2_FINALITY_THRESHOLD_STANDARD);
  assert(
    isDefined(standardFee?.minimumFee),
    `CCTPUtils#getTransferFees: Standard fee not found in API response: ${endpoint}`
  );
  const fastFee = httpResponse.data.find((fee) => fee.finalityThreshold === CCTPV2_FINALITY_THRESHOLD_FAST);
  assert(isDefined(fastFee?.minimumFee), `CCTPUtils#getTransferFees: Fast fee not found in API response: ${endpoint}`);
  return {
    standard: BigNumber.from(standardFee.minimumFee),
    fast: BigNumber.from(fastFee.minimumFee),
  };
}

/**
 * Generates an attestation proof for a given message hash. This is required to finalize a CCTP message.
 * @param messageHash The message hash to generate an attestation proof for. This is generated by taking the keccak256 hash of the message bytes of the initial transaction log.
 * @param isMainnet Whether or not the attestation proof should be generated on mainnet. If this is false, the attestation proof will be generated on the sandbox environment.
 * @returns The attestation status and proof for the given message hash. This is a string of the form "0x<attestation proof>". If the status is pending_confirmation
 * then the proof will be null according to the CCTP dev docs.
 * @link https://developers.circle.com/stablecoins/reference/getattestation
 */
export async function fetchCctpV1Attestation(
  messageHash: string,
  isMainnet: boolean
): Promise<CCTPV1APIGetAttestationResponse> {
  const httpResponse = await axios.get<CCTPV1APIGetAttestationResponse>(
    `https://iris-api${isMainnet ? "" : "-sandbox"}.circle.com/attestations/${messageHash}`
  );
  const attestationResponse = httpResponse.data;
  return attestationResponse;
}

/**
 * @notice Fetches attestations for a given transaction hash. If transaction hash contains multiple CCTP
 * messages, this will return an array of attestations. Should work for both v1 and v2.
 * @param sourceDomainId
 * @param transactionHash
 * @param isMainnet
 * @returns Attestation response, list of messages with attestations.
 */
export async function fetchAttestationsForTxn(
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

/**
 * @notice Returns the CCTP version of the `MessageSent` event.
 * @param log CCTP event log.
 * @returns 0 for v1 `MessageSent` event, 1 for v2, -1 for other events
 */
export function getMessageSentVersion(log: ethers.providers.Log): number {
  if (log.topics[0] !== CCTP_MESSAGE_SENT_TOPIC_HASH) {
    return -1;
  }
  // v1 and v2 have the same topic hash, so we have to do a bit of decoding here to understand the version
  const messageBytes = ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0];
  // Source: https://developers.circle.com/stablecoins/message-format
  const version = parseInt(messageBytes.slice(2, 10), 16); // read version: first 4 bytes (skipping '0x')
  return version;
}

/**
 * @notice Returns the CCTP version of the `DepositForBurn` event.
 * @param log CCTP event log.
 * @returns 0 for v1 `DepositForBurn` event, 1 for v2, -1 for other events
 */
export function getDepositForBurnVersion(log: ethers.providers.Log): number {
  const topic = log.topics[0];
  switch (topic) {
    case CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V1:
      return 0;
    case CCTP_DEPOSIT_FOR_BURN_TOPIC_HASH_V2:
      return 1;
    default:
      return -1;
  }
}
