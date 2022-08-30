export type DistributionRecipients = {
  [address: string]: Pick<DistributionRecipient, "amount" | "accountIndex" | "metadata">;
};
export type DistributionRecipientsWithProofs = { [address: string]: DistributionRecipient };

export type DistributionRecipient = {
  amount: string;
  accountIndex: number;
  windowIndex: number;
  proof: string[];
  metadata: {
    amountBreakdown: {
      [name: string]: string;
    };
  };
};

export type Distribution = {
  chainId: number;
  rewardToken: string;
  totalRewardsDistributed: string;
  recipients: DistributionRecipients;
};
