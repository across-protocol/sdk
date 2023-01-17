import { ethers } from "ethers";

export type CoingeckoDataReturnType = { price: ethers.BigNumber };

export type Fee = {
  total: ethers.BigNumber;
  pct: ethers.BigNumber;
};
export type SuggestedFeeReturnType = {
  relayerFee: Fee;
  relayerGasFee: Fee;
  relayerCapitalFee: Fee;
  isAmountTooLow: boolean;
  quoteTimestamp: ethers.BigNumber;
  quoteBlock: ethers.BigNumber;
};

export type BridgeLimitsReturnType = {
  minDeposit: ethers.BigNumber;
  maxDeposit: ethers.BigNumber;
  maxDepositInstant: ethers.BigNumber;
  maxDepositShortDelay: ethers.BigNumber;
};

export type SpecificRewardType = {
  eligible: boolean;
  completed: boolean;
  amount: string;
};

export type TotalRewardType = {
  welcomeTravellerRewards: SpecificRewardType;
  earlyUserRewards: SpecificRewardType;
  liquidityProviderRewards: SpecificRewardType;
  communityRewards?: SpecificRewardType;
};

export type AcrossBridgeStatisticsType = {
  totalDeposits: number;
  avgFillTime: number;
  totalVolumeUsd: number;
};

export type EndpointResultMappingType = {
  CoinGeckoData: CoingeckoDataReturnType;
  SuggestedFees: SuggestedFeeReturnType;
  BridgeLimits: BridgeLimitsReturnType;
  AcrossStats: AcrossBridgeStatisticsType;
};
