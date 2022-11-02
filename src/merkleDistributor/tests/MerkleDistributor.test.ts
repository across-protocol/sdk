import { MerkleTree } from "@across-protocol/contracts-v2";
import { MerkleDistributor, DistributionRecipient, DistributionRecipientWithProof } from "..";

const dummyRecipients: DistributionRecipient[] = [
  {
    account: "0x00b591bc2b682a0b30dd72bac9406bfa13e5d3cd",
    accountIndex: 0,
    amount: "1000000000000000000",
    metadata: {
      amountBreakdown: {
        source1: "1",
        source2: "1",
        source3: "1",
      },
    },
  },
  {
    account: "0x00e4846e2971bb2b29cec7c9efc8fa686ae21342",
    accountIndex: 1,
    amount: "2000000000000000000",
    metadata: {
      amountBreakdown: {
        source1: "3",
        source2: "1",
        source3: "0",
      },
    },
  },
  {
    account: "0x00e4f5a158ec094da8cf55f8d994b84b6f5f33d9",
    accountIndex: 2,
    amount: "3000000000000000000",
    metadata: {
      amountBreakdown: {
        source1: "0",
        source2: "0",
        source3: "8",
      },
    },
  },
];

describe("MerkleDistributor", () => {
  it("should generate merkle proofs", () => {
    const windowIndex = 0;
    const { merkleRoot, recipientsWithProofs } = MerkleDistributor.createMerkleDistributionProofs(
      dummyRecipients,
      windowIndex
    );
    // Each recipient should contain the correct keys which should not be undefined.
    const expectedKeys: (keyof DistributionRecipientWithProof)[] = ["accountIndex", "metadata", "amount", "proof"];
    Object.keys(recipientsWithProofs).forEach((recipient) => {
      expectedKeys.forEach((expectedKey) => {
        expect(Object.keys(recipientsWithProofs[recipient]).includes(expectedKey)).toBeTruthy();
        expect(recipientsWithProofs[recipient][expectedKey]).toBeDefined();
      });
    });
    // The merkleRoot should match the expected value.
    const merkleTree = new MerkleTree(dummyRecipients, MerkleDistributor.createLeaf);
    expect(merkleTree.getHexRoot()).toEqual(merkleRoot);
  });
});
