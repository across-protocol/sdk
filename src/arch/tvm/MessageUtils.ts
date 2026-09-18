import { utils as ethersUtils } from "ethers";
import { BigNumber, toBN } from "../../utils";

// SUN charged per byte of bandwidth once free allowance is exhausted. Governance-set;
// refresh from `wallet/getchainparameters` if it drifts.
export const TVM_BANDWIDTH_SUN_PER_BYTE = 1000;

// Tron raw_data envelope + one ECDSA signature. Varies with protobuf varint widths: 279
// bytes for 670 empty-message fills, 280 for the 2112-byte test fill — 280 is the observed max.
export const TVM_RAW_DATA_OVERHEAD_BYTES = 280;

/**
 * Bandwidth cost (in SUN) of a Tron tx with this calldata, assuming zero free bandwidth —
 * the true marginal cost even for relayers with staked bandwidth.
 *
 * @throws if `calldata` isn't a valid `0x`-prefixed, even-length hex string.
 */
export function bandwidthCostForCalldata(calldata: string): BigNumber {
  // hexDataLength returns null (not a throw) on malformed input — validate explicitly.
  const calldataBytes = ethersUtils.hexDataLength(calldata);
  if (calldataBytes === null) {
    throw new Error(`bandwidthCostForCalldata: invalid calldata (${calldata})`);
  }
  const txBytes = TVM_RAW_DATA_OVERHEAD_BYTES + calldataBytes;
  return toBN(txBytes).mul(TVM_BANDWIDTH_SUN_PER_BYTE);
}
