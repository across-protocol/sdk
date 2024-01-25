// Lowest ConfigStore version where the V3 model is in effect. The version update to the following value should
// take place atomically with the SpokePool upgrade to V3 so that the dataworker knows what kind of MerkleLeaves
// to propose in root bundles (i.e. RelayerRefundLeaf and SlowFillLeaf have different shapes). We assume that
// V3 will be deployed in between bundles (after a bundle execution and before a proposal). The dataworker/relayer
// code can use the following isV3() function to separate logic for calling V3 vs. legacy methods.
export const V3_MIN_CONFIG_STORE_VERSION = 3;

export function isV3(version: number): boolean {
  return version >= 3;
}
