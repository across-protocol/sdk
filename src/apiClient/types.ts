import { BigNumber } from "../utils";

export type CoingeckoDataReturnType = { price: BigNumber };

export type Fee = {
  total: BigNumber;
  pct: BigNumber;
};
export type SuggestedFeeReturnType = {
  relayerFee: Fee;
  relayerGasFee: Fee;
  relayerCapitalFee: Fee;
  isAmountTooLow: boolean;
  quoteTimestamp: BigNumber;
  quoteBlock: BigNumber;
};

export type BridgeLimitsReturnType = {
  minDeposit: BigNumber;
  maxDeposit: BigNumber;
  maxDepositInstant: BigNumber;
  maxDepositShortDelay: BigNumber;
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
