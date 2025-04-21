import { utils as ethersUtils } from "ethers";
import { MAX_SAFE_DEPOSIT_ID, ZERO_ADDRESS, ZERO_BYTES } from "../constants";
import { Deposit, RelayData } from "../interfaces";
import { toBytes32 } from "./AddressUtils";
import { keccak256 } from "./common";
import { BigNumber, toBN } from "./BigNumberUtils";
import { isMessageEmpty } from "./DepositUtils";
import { chainIsSvm } from "./NetworkUtils";

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
  const _relayData = {
    ...relayData,
    depositor: toBytes32(relayData.depositor),
    recipient: toBytes32(relayData.recipient),
    inputToken: toBytes32(relayData.inputToken),
    outputToken: toBytes32(relayData.outputToken),
    exclusiveRelayer: toBytes32(relayData.exclusiveRelayer),
  };
  if (chainIsSvm(destinationChainId)) {
    return _getRelayDataHashSvm(_relayData, destinationChainId);
  }
  return keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [
        "tuple(" +
          "bytes32 depositor," +
          "bytes32 recipient," +
          "bytes32 exclusiveRelayer," +
          "bytes32 inputToken," +
          "bytes32 outputToken," +
          "uint256 inputAmount," +
          "uint256 outputAmount," +
          "uint256 originChainId," +
          "uint256 depositId," +
          "uint32 fillDeadline," +
          "uint32 exclusivityDeadline," +
          "bytes message" +
          ")",
        "uint256 destinationChainId",
      ],
      [_relayData, destinationChainId]
    )
  );
}

export function getRelayHashFromEvent(e: RelayData & { destinationChainId: number }): string {
  return getRelayDataHash(e, e.destinationChainId);
}

function _getRelayDataHashSvm(relayData: RelayData, destinationChainId: number): string {
  const uint8ArrayFromHexString = (hex: string, littleEndian: boolean = false): Uint8Array => {
    const buffer = Buffer.from(hex.slice(2), "hex");
    if (buffer.length < 32) {
      const zeroPad = new Uint8Array(32);
      buffer.copy(zeroPad, 32 - buffer.length);
      return littleEndian ? zeroPad.reverse() : zeroPad;
    }
    const result = new Uint8Array(buffer.slice(0, 32));
    return littleEndian ? result.reverse() : result;
  };
  const uint8ArrayFromInt = (num: BigNumber, byteLength: number, littleEndian: boolean = true): Uint8Array => {
    const buffer = Buffer.from(num.toHexString().slice(2), "hex");
    if (buffer.length < byteLength) {
      const zeroPad = new Uint8Array(byteLength);
      buffer.copy(zeroPad, byteLength - buffer.length);
      return littleEndian ? zeroPad.reverse() : zeroPad;
    }
    const result = new Uint8Array(buffer.slice(0, byteLength));
    return littleEndian ? result.reverse() : result;
  };
  const contentToHash = Buffer.concat([
    uint8ArrayFromHexString(relayData.depositor),
    uint8ArrayFromHexString(relayData.recipient),
    uint8ArrayFromHexString(relayData.exclusiveRelayer),
    uint8ArrayFromHexString(relayData.inputToken),
    uint8ArrayFromHexString(relayData.outputToken),
    uint8ArrayFromInt(relayData.inputAmount, 8),
    uint8ArrayFromInt(relayData.outputAmount, 8),
    uint8ArrayFromInt(toBN(relayData.originChainId), 8),
    uint8ArrayFromInt(relayData.depositId, 32, false),
    uint8ArrayFromInt(toBN(relayData.fillDeadline), 4),
    uint8ArrayFromInt(toBN(relayData.exclusivityDeadline), 4),
    uint8ArrayFromHexString(getMessageHash(relayData.message)),
    uint8ArrayFromInt(toBN(destinationChainId), 8),
  ]);
  const returnHash = keccak256(contentToHash);
  return returnHash;
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
  return isMessageEmpty(message) ? ZERO_BYTES : keccak256(message);
}
