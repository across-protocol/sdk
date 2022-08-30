import { ethers } from "ethers";
import { DistributionRecipientsWithProofs, DistributionRecipients, MerkleTree } from "./model";

export class MerkleDistributor {
  /**
   * Generate the Merkle root and the proofs for a collection of recipients.
   *
   * @param recipients An object which describes the recipients
   * @param windowIndex Parameter to specify an window index. This allows using the same smart contract for multiple token distributions.
   */
  static createMerkleDistributionProofs(recipients: DistributionRecipients, windowIndex: number) {
    const recipientLeafs = Object.keys(recipients).map((addr: string) =>
      MerkleDistributor.createLeaf(addr, recipients[addr].amount, recipients[addr].accountIndex)
    );
    const merkleTree = new MerkleTree(recipientLeafs);
    const recipientsWithProofs = Object.keys(recipients).reduce((acc, recipientAddress, index) => {
      return {
        ...acc,
        [recipientAddress]: {
          ...recipients[recipientAddress],
          proof: merkleTree.getHexProof(recipientLeafs[index]),
          windowIndex,
        },
      };
    }, {} as DistributionRecipientsWithProofs);
    return { recipientsWithProofs, merkleRoot: merkleTree.getHexRoot() };
  }

  /**
   * Encode the account address, the amount and the account index into a Merkle Tree leaf.
   * It is equivalent to Solidity's keccak256(abi.encode(account, amount))
   * @param account The address of the recipient
   * @param amount The tokens amount which has to be distributed to the account address
   * @param accountIndex The account index
   * @returns The Merkle Tree leaf
   */
  static createLeaf(account: string, amount: string, accountIndex: number) {
    return Buffer.from(
      ethers.utils.solidityKeccak256(["address", "uint256", "uint256"], [account, amount, accountIndex]).slice(2),
      "hex"
    );
  }
}
