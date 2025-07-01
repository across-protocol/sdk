import { encodeAbiParameters, Hex, keccak256 } from "viem";
import { fixedPointAdjustment as fixedPoint } from "./common";
import { MAX_SAFE_DEPOSIT_ID, ZERO_ADDRESS, ZERO_BYTES } from "../constants";
import { Deposit, DepositWithBlock, Fill, FillType, InvalidFill, RelayData, SlowFillLeaf } from "../interfaces";
import { toBytes32 } from "./AddressUtils";
import { BigNumber } from "./BigNumberUtils";
import { isMessageEmpty, validateFillForDeposit } from "./DepositUtils";
import { chainIsSvm, getNetworkName } from "./NetworkUtils";
import { svm } from "../arch";
import { SpokePoolClient } from "../clients";

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
    return svm.getRelayDataHash(relayData, destinationChainId);
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

    // Process each fill
    for (const fill of fills) {
      // Skip fills with unsafe deposit IDs
      // @TODO Deposits with unsafe depositIds should be processed after some time
      if (isUnsafeDepositId(fill.depositId)) {
        continue;
      }

      // Get all deposits (including duplicates) for this fill's depositId, both in memory and on-chain
      const depositResult = await spokePoolClients[fill.originChainId]?.findAllDeposits(fill.depositId);

      // If no deposits found at all
      if (!depositResult?.found) {
        invalidFills.push({
          fill,
          validationResults: [
            {
              reason: `No ${getNetworkName(fill.originChainId)} deposit with depositId ${fill.depositId} found`,
            },
          ],
        });
        continue;
      }

      // Try to find a valid deposit for this fill
      let foundValidDeposit = false;
      const validationResults: Array<{ reason: string; deposit: DepositWithBlock }> = [];

      for (const deposit of depositResult.deposits) {
        // Validate the fill against the deposit
        const validationResult = validateFillForDeposit(fill, deposit);
        if (validationResult.valid) {
          foundValidDeposit = true;
          break;
        }
        validationResults.push({
          reason: validationResult.reason,
          deposit,
        });
      }

      // If no valid deposit was found, add to invalid fills with all validation results
      if (!foundValidDeposit) {
        invalidFills.push({
          fill,
          validationResults,
        });
      }
    }
  }

  return invalidFills;
}
