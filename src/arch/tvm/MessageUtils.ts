import { RelayData } from "../../interfaces";
import { BigNumber, bnZero, isMessageEmpty, toBN } from "../../utils";

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

/**
 * Estimate the bandwidth cost (in SUN) of a Tron fill for `deposit`.
 *
 * On Tron, transaction bytes consume bandwidth — distinct from energy (paid via the tx
 * fee limit and modeled in `nativeGasCost`). When the relayer has no free bandwidth
 * staked, every byte burns 1,000 SUN. For message-bearing fills this is non-trivial:
 * the message dominates calldata size, so the cost scales linearly with message length.
 *
 * The estimate is conservative — it assumes zero free bandwidth (worst case). Relayers
 * that stake TRX for bandwidth pay 0 onchain; this still represents the true marginal
 * cost of consuming that staked allowance.
 */
export function getAuxiliaryNativeTokenCost(deposit: RelayData): BigNumber {
  const messageBytes = isMessageEmpty(deposit.message) ? 0 : Math.max(0, Math.floor((deposit.message.length - 2) / 2));
  const paddedMessageBytes = Math.ceil(messageBytes / 32) * 32;

  const calldataBytes = TVM_FILL_RELAY_FIXED_CALLDATA_BYTES + paddedMessageBytes;
  const txBytes = TVM_RAW_DATA_OVERHEAD_BYTES + calldataBytes;

  return toBN(txBytes).mul(TVM_BANDWIDTH_SUN_PER_BYTE);
}

// Re-export so other arches can reference the zero default if needed.
export const tvmBandwidthCostZero = bnZero;
