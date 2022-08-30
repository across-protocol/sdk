import { ethers } from "ethers";
import { DistributionRecipientsWithProofs, DistributionRecipients, MerkleTree } from "./model";

export class MerkleDistributor {
  static createMerkleDistributionProofs = (recipients: DistributionRecipients, windowIndex: number) => {
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
  };

  // keccak256(abi.encode(account, amount))
  static createLeaf = (account: string, amount: string, accountIndex: number) => {
    return Buffer.from(
      ethers.utils.solidityKeccak256(["address", "uint256", "uint256"], [account, amount, accountIndex]).slice(2),
      "hex"
    );
  };
}
