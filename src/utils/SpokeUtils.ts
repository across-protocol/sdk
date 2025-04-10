import { encodeAbiParameters, keccak256 } from "viem";
import { MAX_SAFE_DEPOSIT_ID, ZERO_ADDRESS, ZERO_BYTES } from "../constants";
import { Deposit, RelayData } from "../interfaces";
import { toBytes32 } from "./AddressUtils";
import { BigNumber } from "./BigNumberUtils";
import { isMessageEmpty } from "./DepositUtils";

/**
 * Produce the RelayData for a Deposit.
 * @param deposit Deposit instance.
 * @returns The corresponding RelayData object.
 */
export function getDepositRelayData(deposit: Omit<Deposit, "messageHash">): RelayData {
  return {
    depositor: toBytes32(deposit.depositor),
    recipient: toBytes32(deposit.recipient),
    exclusiveRelayer: toBytes32(deposit.exclusiveRelayer),
    inputToken: toBytes32(deposit.inputToken),
    outputToken: toBytes32(deposit.outputToken),
    inputAmount: deposit.inputAmount,
    outputAmount: deposit.outputAmount,
    originChainId: deposit.originChainId,
    depositId: deposit.depositId,
    fillDeadline: deposit.fillDeadline,
    exclusivityDeadline: deposit.exclusivityDeadline,
    message: deposit.message,
  };
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(relayData: RelayData, destinationChainId: number): string {
  const abi = [
    {
      type: "tuple",
      components: [
        { type: "bytes32", name: "depositor" },
        { type: "bytes32", name: "recipient" },
        { type: "bytes32", name: "exclusiveRelayer" },
        { type: "bytes32", name: "inputToken" },
        { type: "bytes32", name: "outputToken" },
        { type: "uint256", name: "inputAmount" },
        { type: "uint256", name: "outputAmount" },
        { type: "uint256", name: "originChainId" },
        { type: "uint256", name: "depositId" },
        { type: "uint32", name: "fillDeadline" },
        { type: "uint32", name: "exclusivityDeadline" },
        { type: "bytes", name: "message" },
      ],
    },
    { type: "uint256", name: "destinationChainId" },
  ];

  const _relayData = {
    ...relayData,
    depositor: toBytes32(relayData.depositor),
    recipient: toBytes32(relayData.recipient),
    inputToken: toBytes32(relayData.inputToken),
    outputToken: toBytes32(relayData.outputToken),
    exclusiveRelayer: toBytes32(relayData.exclusiveRelayer),
  };

  return keccak256(encodeAbiParameters(abi, [_relayData, destinationChainId]));
}

export function getRelayHashFromEvent(e: RelayData & { destinationChainId: number }): string {
  return getRelayDataHash(e, e.destinationChainId);
}

export function isUnsafeDepositId(depositId: BigNumber): boolean {
  // SpokePool.unsafeDepositV3() produces a uint256 depositId by hashing the msg.sender, depositor and input
  // uint256 depositNonce. There is a possibility that this resultant uint256 is less than the maxSafeDepositId (i.e.
  // the maximum uint32 value) which makes it possible that an unsafeDepositV3's depositId can collide with a safe
  // depositV3's depositId, but the chances of a collision are 1 in 2^(256 - 32), so we'll ignore this
  // possibility.
  const maxSafeDepositId = BigNumber.from(MAX_SAFE_DEPOSIT_ID);
  return maxSafeDepositId.lt(depositId);
}

// Determines if the input address (either a bytes32 or bytes20) is the zero address.
export function isZeroAddress(address: string): boolean {
  return address === ZERO_ADDRESS || address === ZERO_BYTES;
}

export function getMessageHash(message: string): string {
  return isMessageEmpty(message) ? ZERO_BYTES : keccak256(message as "0x{string}");
}
