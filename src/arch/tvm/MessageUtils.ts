import { utils as ethersUtils } from "ethers";
import { BigNumber, toBN } from "../../utils";

// Tron prices each byte of a transaction's serialized raw_data + signature at this many
// SUN of bandwidth when the relayer's free bandwidth allowance has been exhausted. The
// rate is set by Tron governance; refresh from `wallet/getchainparameters` if it drifts.
export const TVM_BANDWIDTH_SUN_PER_BYTE = 1000;

// Tron raw_data envelope (contract type, ref_block, timestamp, expiration, fee_limit)
// plus a single ECDSA signature. Measured at 280 bytes.
export const TVM_RAW_DATA_OVERHEAD_BYTES = 280;

/**
 * Bandwidth cost (in SUN) of a Tron transaction whose calldata is `calldata`. Assumes zero
 * free bandwidth (worst case); relayers with staked bandwidth pay 0 onchain, but this is
 * still the true marginal cost of consuming that stake.
 *
 * @throws if `calldata` isn't a valid `0x`-prefixed, even-length hex string.
 */
export function bandwidthCostForCalldata(calldata: string): BigNumber {
  // ethers' hexDataLength returns null (not a throw) for malformed input, so validate
  // explicitly rather than let a bad calldata string silently become a wrong byte count.
  const calldataBytes = ethersUtils.hexDataLength(calldata);
  if (calldataBytes === null) {
    throw new Error(`bandwidthCostForCalldata: invalid calldata (${calldata})`);
  }
  const txBytes = TVM_RAW_DATA_OVERHEAD_BYTES + calldataBytes;
  return toBN(txBytes).mul(TVM_BANDWIDTH_SUN_PER_BYTE);
}
