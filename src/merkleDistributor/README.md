# Merkle Distributor 

This package contains the logic for managing Merkle trees: create leafs, generate Merkle trees and proofs.
Also, `MerkleDistributor` is a wrapper around the Merkle tree which is used for managing the recipients of the ACX token airdrop.

## Usage

See tests for more documentation: [MerkleDistributor]("./test/MerkleDistributor.test.ts")

```ts
import * as across from "@across-protocol/sdk-v2";

const { MerkleDistributor, MerkleTree, DistributionRecipient } = across.merkleDistributor;

const windowIndex = 0;
const recipients: DistributionRecipient[] = [
  {
    account: "0x00b591bc2b682a0b30dd72bac9406bfa13e5d3cd",
    accountIndex: 0,
    amount: "1000000000000000000",
    metadata: {
      amountBreakdown: {
        name: "5000000000000000",
      },
    },
  },
// ...other recipients data
];
const { merkleRoot, recipientsWithProofs } = MerkleDistributor.createMerkleDistributionProofs(recipients, windowIndex);
```
