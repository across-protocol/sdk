import { utils as ethersUtils } from "ethers";
import { BigNumber, bnZero, toBN } from "../../utils";

// Tron prices each byte of a transaction's serialized raw_data + signature at this many
// SUN of bandwidth when the relayer's free bandwidth allowance has been exhausted. The
// rate is set by Tron governance; refresh from `wallet/getchainparameters` if it drifts.
export const TVM_BANDWIDTH_SUN_PER_BYTE = 1000;

// Tron raw_data envelope (contract type, ref_block, timestamp, expiration, fee_limit)
// plus a single ECDSA signature. Measured at 280 bytes.
export const TVM_RAW_DATA_OVERHEAD_BYTES = 280;

/**
 * Estimate the bandwidth cost (in SUN) of a Tron transaction whose calldata is `calldata`.
 *
 * On Tron, transaction bytes consume bandwidth — distinct from energy (paid via the tx
 * fee limit and modeled in `nativeGasCost`). When the relayer has no free bandwidth
 * staked, every byte burns 1,000 SUN.
 *
 * The estimate is conservative — it assumes zero free bandwidth (worst case). Relayers
 * that stake TRX for bandwidth pay 0 onchain; this still represents the true marginal
 * cost of consuming that staked allowance.
 *
 * @throws if `calldata` isn't a valid `0x`-prefixed, even-length hex string.
 */
export function getAuxiliaryNativeTokenCost(calldata: string): BigNumber {
  // ethers' hexDataLength returns null (not a throw) for malformed input, so validate
  // explicitly rather than let a bad calldata string silently become a wrong byte count.
  const calldataBytes = ethersUtils.hexDataLength(calldata);
  if (calldataBytes === null) {
    throw new Error(`getAuxiliaryNativeTokenCost: invalid calldata (${calldata})`);
  }
  const txBytes = TVM_RAW_DATA_OVERHEAD_BYTES + calldataBytes;
  return toBN(txBytes).mul(TVM_BANDWIDTH_SUN_PER_BYTE);
}

// Re-export so other arches can reference the zero default if needed.
export const tvmBandwidthCostZero = bnZero;
