export type DistributionRecipientsWithProofs = { [address: string]: DistributionRecipientWithProof };

export type DistributionRecipient = {
  amount: string;
  account: string;
  accountIndex: number;
  metadata: {
    amountBreakdown: {
      [name: string]: string;
    };
  };
};

export type DistributionRecipientWithProof = DistributionRecipient & {
  windowIndex: number;
  proof: string[];
};
