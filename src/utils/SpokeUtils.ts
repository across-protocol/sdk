import { encodeAbiParameters, Hex, keccak256 } from "viem";
import { fixedPointAdjustment as fixedPoint } from "./common";
import { MAX_SAFE_DEPOSIT_ID, ZERO_BYTES } from "../constants";
import { Fill, FillType, RelayDataWithMessageHash, SlowFillLeaf } from "../interfaces";
import { BigNumber } from "./BigNumberUtils";
import { isMessageEmpty } from "./DepositUtils";
import { chainIsSvm } from "./NetworkUtils";
import { svm } from "../arch";

export function isSlowFill(fill: Fill): boolean {
  return fill.relayExecutionInfo.fillType === FillType.SlowFill;
}

export function getSlowFillLeafLpFeePct(leaf: SlowFillLeaf): BigNumber {
  const { relayData, updatedOutputAmount } = leaf;
  return relayData.inputAmount.sub(updatedOutputAmount).mul(fixedPoint).div(relayData.inputAmount);
}
/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(relayData: RelayDataWithMessageHash, destinationChainId: number): string {
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
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };
  if (chainIsSvm(destinationChainId)) {
    return svm.getRelayDataHash(relayData, destinationChainId);
  }
  return keccak256(encodeAbiParameters(abi, [_relayData, destinationChainId]));
}

export function getRelayHashFromEvent(e: RelayDataWithMessageHash & { destinationChainId: number }): string {
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

export function getMessageHash(message: string): string {
  return isMessageEmpty(message) ? ZERO_BYTES : keccak256(message as Hex);
}
