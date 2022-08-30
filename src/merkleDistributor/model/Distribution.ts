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

export type DistributionRecipientWithProof = {
  amount: string;
  account: string;
  accountIndex: number;
  windowIndex: number;
  proof: string[];
  metadata: {
    amountBreakdown: {
      [name: string]: string;
    };
  };
};
