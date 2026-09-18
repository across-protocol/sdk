import { RelayData, SpeedUpCommon } from "../../interfaces";
import { BigNumber, bnZero, isDefined, isMessageEmpty, toBN } from "../../utils";

// Tron prices each byte of a transaction's serialized raw_data + signature at this many
// SUN of bandwidth when the relayer's free bandwidth allowance has been exhausted. The
// rate is set by Tron governance; refresh from `wallet/getchainparameters` if it drifts.
export const TVM_BANDWIDTH_SUN_PER_BYTE = 1000;

// Tron raw_data envelope (contract type, ref_block, timestamp, expiration, fee_limit)
// plus a single ECDSA signature. Measured at 280 bytes.
export const TVM_RAW_DATA_OVERHEAD_BYTES = 280;

const ABI_WORD_BYTES = 32;
const ABI_SELECTOR_BYTES = 4;

// fillRelay(V3RelayData, uint256 repaymentChainId, bytes32 repaymentAddress) calldata,
// excluding the `message` payload (dynamic, added separately).
const FILL_RELAY_TOP_LEVEL_HEAD_BYTES = 3 * ABI_WORD_BYTES; // offset(V3RelayData) + repaymentChainId + repaymentAddress
const V3_RELAY_DATA_HEAD_BYTES = 12 * ABI_WORD_BYTES; // 11 static fields + offset(message)
const MESSAGE_LENGTH_HEADER_BYTES = ABI_WORD_BYTES;

export const TVM_FILL_RELAY_FIXED_CALLDATA_BYTES =
  ABI_SELECTOR_BYTES + FILL_RELAY_TOP_LEVEL_HEAD_BYTES + V3_RELAY_DATA_HEAD_BYTES + MESSAGE_LENGTH_HEADER_BYTES;

// Extra fillRelayWithUpdatedDeposit(V3RelayData, ..., uint256 updatedOutputAmount, bytes32
// updatedRecipient, bytes updatedMessage, bytes speedUpSignature) calldata beyond the
// plain fillRelay encoding above (the original `message` is already counted there).
const SPEED_UP_EXTRA_HEAD_BYTES = 4 * ABI_WORD_BYTES; // updatedOutputAmount + updatedRecipient + offset(updatedMessage) + offset(speedUpSignature)
const UPDATED_MESSAGE_LENGTH_HEADER_BYTES = ABI_WORD_BYTES;
const SPEED_UP_SIGNATURE_LENGTH_HEADER_BYTES = ABI_WORD_BYTES;
const PADDED_ECDSA_SIGNATURE_BYTES = 3 * ABI_WORD_BYTES; // 65-byte signature, padded up to full words

export const TVM_SPEED_UP_FIXED_CALLDATA_EXTRA_BYTES =
  SPEED_UP_EXTRA_HEAD_BYTES +
  UPDATED_MESSAGE_LENGTH_HEADER_BYTES +
  SPEED_UP_SIGNATURE_LENGTH_HEADER_BYTES +
  PADDED_ECDSA_SIGNATURE_BYTES;

function paddedMessageByteLength(message: string | undefined): number {
  if (!isDefined(message) || isMessageEmpty(message)) return 0;
  const bytes = Math.max(0, Math.floor((message.length - 2) / 2));
  return Math.ceil(bytes / ABI_WORD_BYTES) * ABI_WORD_BYTES;
}

/**
 * Estimate the bandwidth cost (in SUN) of a Tron fill for `deposit`.
 *
 * On Tron, transaction bytes consume bandwidth — distinct from energy (paid via the tx
 * fee limit and modeled in `nativeGasCost`). When the relayer has no free bandwidth
 * staked, every byte burns 1,000 SUN. For message-bearing fills this is non-trivial:
 * the message dominates calldata size, so the cost scales linearly with message length.
 *
 * Sped-up deposits (those carrying a `speedUpSignature`) are filled via
 * `fillRelayWithUpdatedDeposit`, which carries the original `V3RelayData` *and*
 * `updatedMessage`/`speedUpSignature` as additional ABI args. Both messages are charged.
 *
 * The estimate is conservative — it assumes zero free bandwidth (worst case). Relayers
 * that stake TRX for bandwidth pay 0 onchain; this still represents the true marginal
 * cost of consuming that staked allowance.
 */
export function getAuxiliaryNativeTokenCost(
  deposit: RelayData & Partial<SpeedUpCommon> & { speedUpSignature?: string }
): BigNumber {
  const paddedMessageBytes = paddedMessageByteLength(deposit.message);

  let speedUpExtraBytes = 0;
  if (isDefined(deposit.speedUpSignature) && deposit.speedUpSignature !== "0x") {
    speedUpExtraBytes = TVM_SPEED_UP_FIXED_CALLDATA_EXTRA_BYTES + paddedMessageByteLength(deposit.updatedMessage);
  }

  const calldataBytes = TVM_FILL_RELAY_FIXED_CALLDATA_BYTES + paddedMessageBytes + speedUpExtraBytes;
  const txBytes = TVM_RAW_DATA_OVERHEAD_BYTES + calldataBytes;

  return toBN(txBytes).mul(TVM_BANDWIDTH_SUN_PER_BYTE);
}

// Re-export so other arches can reference the zero default if needed.
export const tvmBandwidthCostZero = bnZero;
