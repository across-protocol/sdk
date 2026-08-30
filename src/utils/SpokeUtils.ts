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
import { averageBlockTime as evmAverageBlockTime } from "../arch/evm";
import { averageBlockTime as svmAverageBlockTime } from "../arch/svm";
import { EVMSpokePoolClient, SpokePoolClient } from "../clients";
import { EVM_SPOKE_POOL_CLIENT_TYPE, SVM_SPOKE_POOL_CLIENT_TYPE } from "../clients/SpokePoolClient/types";
import { BigNumber } from "./BigNumberUtils";
import { isMessageEmpty, validateFillForDeposit } from "./DepositUtils";
import { chainIsSvm, getNetworkName } from "./NetworkUtils";
import { toAddressType } from "./AddressUtils";

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

const RELAYDATA_ABI = [
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

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(relayData: RelayData, destinationChainId: number): string {
  if (chainIsSvm(destinationChainId)) {
    const messageHash = getMessageHash(relayData.message);
    return svm.getRelayDataHash({ ...relayData, messageHash }, destinationChainId);
  }

  const _relayData = {
    ...relayData,
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };
  return keccak256(encodeAbiParameters(RELAYDATA_ABI, [_relayData, destinationChainId]));
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

/** Grace period before reporting fills with unsafe deposit IDs as invalid. */
export const DEFAULT_UNSAFE_DEPOSIT_GRACE_PERIOD_SEC = 10 * 60;

/**
 * Estimates how many seconds have elapsed since a fill was included on-chain by extrapolating
 * from the gap between the client's latest searched height and the fill's block/slot.
 */
export async function estimateFillAgeSec(spokePoolClient: SpokePoolClient, fill: FillWithBlock): Promise<number> {
  const heightDelta = Math.max(0, spokePoolClient.latestHeightSearched - fill.blockNumber);

  if (spokePoolClient.type === EVM_SPOKE_POOL_CLIENT_TYPE) {
    const { spokePool } = spokePoolClient as EVMSpokePoolClient;
    const { average } = await evmAverageBlockTime(spokePool.provider);
    return heightDelta * average;
  }

  if (spokePoolClient.type === SVM_SPOKE_POOL_CLIENT_TYPE) {
    const { average } = svmAverageBlockTime();
    return heightDelta * average;
  }

  throw new Error(
    `Unable to estimate fill age for unsupported SpokePoolClient type (${spokePoolClient.type}) on chain ${spokePoolClient.chainId}`
  );
}

export async function findInvalidFills(
  spokePoolClients: { [chainId: number]: SpokePoolClient },
  unsafeDepositGracePeriodSec = DEFAULT_UNSAFE_DEPOSIT_GRACE_PERIOD_SEC
): Promise<InvalidFill[]> {
  const invalidFills: InvalidFill[] = [];

  // Iterate through each spoke pool client
  for (const spokePoolClient of Object.values(spokePoolClients)) {
    // Get all fills for this client
    const fills = spokePoolClient.getFills();

    // Process fills in parallel for this client
    const fillDepositPairs = await Promise.all(
      fills.map(async (fill) => {
        const originClient = spokePoolClients[fill.originChainId];
        const unsafeDeposit = isUnsafeDepositId(fill.depositId);

        // Unsafe deposit IDs cannot be located via on-chain historical binary search, so only consult
        // deposits already indexed in the origin SpokePoolClient's memory.
        let deposit;
        if (unsafeDeposit) {
          deposit = originClient?.getDeposit(fill.depositId);
        } else {
          const depositResult = await originClient?.findDeposit(fill.depositId);
          deposit = depositResult?.found ? depositResult.deposit : undefined;
        }

        if (!deposit) {
          // Fills from unsafeDepositV3() use uint256 deposit IDs. Allow time for the origin-chain
          // deposit to be indexed before treating the fill as invalid.
          if (unsafeDeposit) {
            const estimatedFillAgeSec = await estimateFillAgeSec(spokePoolClient, fill);
            if (estimatedFillAgeSec < unsafeDepositGracePeriodSec) {
              return null;
            }
          }

          return {
            fill,
            deposit: null,
            reason: `No ${getNetworkName(fill.originChainId)} deposit with depositId ${fill.depositId} found`,
          };
        }

        // Check if fill is valid for deposit
        const validationResult = validateFillForDeposit(fill, deposit);
        if (!validationResult.valid) {
          return {
            fill,
            deposit,
            reason: validationResult.reason,
          };
        }

        // Valid fill with deposit - return null to filter out
        return null;
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
