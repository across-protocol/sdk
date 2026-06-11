import { RelayData, SpeedUpCommon } from "../../interfaces";
import { BigNumber, bnZero, isDefined, isMessageEmpty, toBN } from "../../utils";

// Tron prices each byte of a transaction's serialized raw_data + signature at this many
// SUN of bandwidth when the relayer's free bandwidth allowance has been exhausted. The
// rate is set by Tron governance; refresh from `wallet/getchainparameters` if it drifts.
const TVM_BANDWIDTH_SUN_PER_BYTE = 1000;

// Tron raw_data envelope (contract type, ref_block, timestamp, expiration, fee_limit)
// plus a single ECDSA signature. Measured empirically against `fillRelay` transactions
// emitted by the production relayer; varies by ~10 bytes between calls.
const TVM_RAW_DATA_OVERHEAD_BYTES = 290;

// `fillRelay(V3RelayData, uint256 repaymentChainId, bytes32 repaymentAddress)` ABI
// encoding, excluding the `message` payload (which is dynamic).
//   4   selector
//  96   top-level head: offset(V3RelayData) + repaymentChainId + repaymentAddress
// 384   V3RelayData struct head: 11 static fields inline + 1 offset(message)
//  32   message length header
const TVM_FILL_RELAY_FIXED_CALLDATA_BYTES = 4 + 96 + 384 + 32;

// Extra ABI footprint when a speed-up signature is present and the relayer must call
// `fillRelayWithUpdatedDeposit(V3RelayData, ..., uint256 updatedOutputAmount, bytes32
// updatedRecipient, bytes updatedMessage, bytes speedUpSignature)`. The original
// `message` still lives inside V3RelayData and is already counted above; this constant
// captures only what's *additional* to the plain `fillRelay` encoding.
//  128   4 extra head slots: updatedOutputAmount + updatedRecipient + offset(updatedMessage) + offset(speedUpSignature)
//   32   updatedMessage length header (the padded body is added per-call below)
//   32   speedUpSignature length header
//   96   65-byte ECDSA signature padded to 3 EVM words
const TVM_SPEED_UP_FIXED_CALLDATA_EXTRA_BYTES = 128 + 32 + 32 + 96;

function paddedMessageByteLength(message: string | undefined): number {
  if (!isDefined(message) || isMessageEmpty(message)) return 0;
  const bytes = Math.max(0, Math.floor((message.length - 2) / 2));
  return Math.ceil(bytes / 32) * 32;
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
