import { encodeAbiParameters, Hex, keccak256 } from "viem";
import { fixedPointAdjustment as fixedPoint } from "./common";
import { MAX_SAFE_DEPOSIT_ID, ZERO_BYTES } from "../constants";
import {
  DepositWithBlock,
  Fill,
  FillWithBlock,
  FillType,
  InvalidFill,
  RelayData,
  RelayExecutionEventInfo,
  SlowFillLeaf,
  SortableEvent,
} from "../interfaces";
import { svm } from "../arch";
import { BigNumber } from "./BigNumberUtils";
import { isMessageEmpty, validateFillForDeposit } from "./DepositUtils";
import { chainIsSvm, getNetworkName } from "./NetworkUtils";
import { toAddressType } from "./AddressUtils";
import { SpokePoolClient } from "../clients";

export function isSlowFill(fill: Fill): boolean {
  return fill.relayExecutionInfo.fillType === FillType.SlowFill;
}

export function getSlowFillLeafLpFeePct(leaf: SlowFillLeaf): BigNumber {
  const { relayData, updatedOutputAmount } = leaf;
  return relayData.inputAmount.sub(updatedOutputAmount).mul(fixedPoint).div(relayData.inputAmount);
}

/**
 * Given a SortableEvent type, unpack the available FundsDeposited fields.
 * @note Some fields cannot be evaluated without additional context - i.e. quoteBlockNumber, {from,to}LiteChain.
 * @param rawEvent emitted by FundsDeposited event.
 * @param originChainId Deposit originChainId
 * @returns A mostly-populated DepositWithBlock event.
 */
export function unpackDepositEvent(
  rawEvent: SortableEvent,
  originChainId: number
): Omit<DepositWithBlock, "quoteBlockNumber" | "fromLiteChain" | "toLiteChain"> {
  const event = rawEvent as Omit<
    DepositWithBlock,
    | "originChainId"
    | "depositor"
    | "recipient"
    | "inputToken"
    | "outputToken"
    | "exclusiveRelayer"
    | "quoteBlockNumber"
    | "fromLiteChain"
    | "toLiteChain"
  > & {
    depositor: string;
    recipient: string;
    inputToken: string;
    outputToken: string;
    exclusiveRelayer: string;
  };

  return {
    ...event,
    originChainId,
    depositor: toAddressType(event.depositor, originChainId),
    recipient: toAddressType(event.recipient, event.destinationChainId),
    inputToken: toAddressType(event.inputToken, originChainId),
    outputToken: toAddressType(event.outputToken, event.destinationChainId),
    exclusiveRelayer: toAddressType(event.exclusiveRelayer, event.destinationChainId),
    messageHash: getMessageHash(event.message),
  } satisfies Omit<DepositWithBlock, "quoteBlockNumber" | "fromLiteChain" | "toLiteChain">;
}

/**
 * Given a SortableEvent type, unpack the complete set of FilledRelay fields.
 * @param rawEvent emitted by FundsDeposited event.
 * @param originChainId Deposit originChainId
 * @returns A mostly-populated DepositWithBlock event.
 */
export function unpackFillEvent(rawEvent: SortableEvent, destinationChainId: number): FillWithBlock {
  const event = rawEvent as Omit<
    FillWithBlock,
    | "destinationChainId"
    | "depositor"
    | "recipient"
    | "inputToken"
    | "outputToken"
    | "exclusiveRelayer"
    | "relayer"
    | "relayerExecutionInfo"
  > & {
    depositor: string;
    recipient: string;
    inputToken: string;
    outputToken: string;
    exclusiveRelayer: string;
    relayer: string;
    relayExecutionInfo: Omit<RelayExecutionEventInfo, "updatedRecipient"> & { updatedRecipient: string };
  };

  return {
    ...event,
    destinationChainId,
    depositor: toAddressType(event.depositor, event.originChainId),
    recipient: toAddressType(event.recipient, destinationChainId),
    inputToken: toAddressType(event.inputToken, event.originChainId),
    outputToken: toAddressType(event.outputToken, destinationChainId),
    exclusiveRelayer: toAddressType(event.exclusiveRelayer, destinationChainId),
    relayer: toAddressType(event.relayer, event.repaymentChainId),
    relayExecutionInfo: {
      ...event.relayExecutionInfo,
      updatedRecipient: toAddressType(event.relayExecutionInfo.updatedRecipient, destinationChainId),
    },
  } satisfies FillWithBlock;
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
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };
  if (chainIsSvm(destinationChainId)) {
    const messageHash = getMessageHash(relayData.message);
    return svm.getRelayDataHash({ ...relayData, messageHash }, destinationChainId);
  }
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

export function getMessageHash(message: string): string {
  return isMessageEmpty(message) ? ZERO_BYTES : keccak256(message as Hex);
}

export async function findInvalidFills(spokePoolClients: {
  [chainId: number]: SpokePoolClient;
}): Promise<InvalidFill[]> {
  const invalidFills: InvalidFill[] = [];

  // Iterate through each spoke pool client
  for (const spokePoolClient of Object.values(spokePoolClients)) {
    // Get all fills for this client
    const fills = spokePoolClient.getFills();

    // Process fills in parallel for this client
    const fillDepositPairs = await Promise.all(
      fills.map(async (fill) => {
        // Skip fills with unsafe deposit IDs
        if (isUnsafeDepositId(fill.depositId)) {
          return null; // Return null for unsafe deposits
        }

        try {
          // Get all deposits (including duplicates) for this fill's depositId, both in memory and on-chain
          const depositResult = await spokePoolClients[fill.originChainId]?.findDeposit(fill.depositId);

          // If no deposits found at all
          if (!depositResult?.found) {
            return {
              fill,
              deposit: null,
              reason: `No ${getNetworkName(fill.originChainId)} deposit with depositId ${fill.depositId} found`,
            };
          }

          // Check if fill is valid for deposit
          const validationResult = validateFillForDeposit(fill, depositResult.deposit);
          if (!validationResult.valid) {
            return {
              fill,
              deposit: depositResult.deposit,
              reason: validationResult.reason,
            };
          }

          // Valid fill with deposit - return null to filter out
          return null;
        } catch (error) {
          return {
            fill,
            deposit: null,
            reason: `Error processing fill: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      })
    );

    for (const pair of fillDepositPairs) {
      if (pair) {
        invalidFills.push({
          fill: pair.fill,
          reason: pair.reason,
          deposit: pair.deposit || undefined,
        });
      }
    }
  }

  return invalidFills;
}
