import { MerkleTree } from "@across-protocol/contracts";
import { PoolRebalanceLeaf } from "../../../interfaces";
import { getParamType } from "../../../utils/ContractUtils";
import { utils } from "ethers";

export function buildPoolRebalanceLeafTree(poolRebalanceLeaves: PoolRebalanceLeaf[]): MerkleTree<PoolRebalanceLeaf> {
  for (let i = 0; i < poolRebalanceLeaves.length; i++) {
    // The 4 provided parallel arrays must be of equal length. Running Balances can optionally be 2x the length
    if (
      poolRebalanceLeaves[i].l1Tokens.length !== poolRebalanceLeaves[i].bundleLpFees.length ||
      poolRebalanceLeaves[i].netSendAmounts.length !== poolRebalanceLeaves[i].bundleLpFees.length
    ) {
      throw new Error("Provided lef arrays are not of equal length");
    }
    if (
      poolRebalanceLeaves[i].runningBalances.length !== poolRebalanceLeaves[i].bundleLpFees.length * 2 &&
      poolRebalanceLeaves[i].runningBalances.length !== poolRebalanceLeaves[i].bundleLpFees.length
    ) {
      throw new Error("Running balances length unexpected");
    }
  }

  const paramType = getParamType("MerkleLibTest", "verifyPoolRebalance", "rebalance");
  const hashFn = (input: PoolRebalanceLeaf) => {
    const ethersLeaf = {
      ...input,
      l1Tokens: input.l1Tokens.map((l1Token) => l1Token.formatAsChecksummedEvmAddress()),
    };
    return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [ethersLeaf]));
  };
  return new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, hashFn);
}
