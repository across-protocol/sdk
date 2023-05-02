import { MerkleTree } from "@across-protocol/contracts-v2/dist/utils/MerkleTree";
import { ethers } from "ethers";
import { DistributionRecipientsWithProofs, DistributionRecipient } from "./model";

export class MerkleDistributor {
  /**
   * Generate the Merkle root and the proofs for a collection of recipients.
   *
   * @param recipients An object which describes the recipients
   * @param windowIndex Parameter to specify an window index. This allows using the same smart contract for multiple token distributions.
   */
  static createMerkleDistributionProofs(recipients: DistributionRecipient[], windowIndex: number) {
    const merkleTree = new MerkleTree<DistributionRecipient>(recipients, MerkleDistributor.createLeaf);
    const recipientsWithProofs = recipients.reduce((acc, recipient) => {
      return {
        ...acc,
        [recipient.account]: {
          ...recipient,
          proof: merkleTree.getHexProof(recipient),
          windowIndex,
        },
      };
    }, {} as DistributionRecipientsWithProofs);
    return { recipientsWithProofs, merkleRoot: merkleTree.getHexRoot() };
  }

  /**
   * Encode the account address, the amount and the account index into a Merkle Tree leaf.
   * It is equivalent to Solidity's keccak256(abi.encode(account, amount))
   * @param recipient The recipient of the token distribution
   * @returns The Merkle Tree leaf
   */
  static createLeaf(recipient: DistributionRecipient) {
    const { account, amount, accountIndex } = recipient;
    return ethers.utils.solidityKeccak256(["address", "uint256", "uint256"], [account, amount, accountIndex]);
  }
}
