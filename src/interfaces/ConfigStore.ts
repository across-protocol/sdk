import { RateModel } from "../lpFeeCalculator";
import { BigNumber } from "../utils";
import { SortableEvent } from "./Common";

export interface ParsedTokenConfig {
  rateModel: RateModel;
  routeRateModel?: {
    [path: string]: RateModel;
  };
  spokeTargetBalances?: {
    [chainId: number]: {
      target: string;
      threshold: string;
    };
  };
}

export interface SpokePoolTargetBalance {
  target: BigNumber;
  threshold: BigNumber;
}

export type SpokePoolTargetBalanceStringified = Omit<SpokePoolTargetBalance, "threshold" | "target"> & {
  target: string;
  threshold: string;
};

export interface SpokeTargetBalanceUpdate extends SortableEvent {
  spokeTargetBalances?: {
    [chainId: number]: SpokePoolTargetBalance;
  };
  l1Token: string;
}

export interface SpokeTargetBalanceUpdateStringified extends SortableEvent {
  spokeTargetBalances?: {
    [chainId: number]: SpokePoolTargetBalanceStringified;
  };
  l1Token: string;
}

export interface RouteRateModelUpdate extends SortableEvent {
  routeRateModel: {
    [path: string]: string;
  };
  l1Token: string;
}

export interface RateModelUpdate extends SortableEvent {
  rateModel: string;
  l1Token: string;
}

export interface TokenConfig extends SortableEvent {
  key: string;
  value: string;
}

export interface GlobalConfigUpdate<ValueStore = number> extends SortableEvent {
  value: ValueStore;
}

export interface ConfigStoreVersionUpdate<ValueStore = number> extends GlobalConfigUpdate<ValueStore> {
  timestamp: number;
}

export interface DisabledChainsUpdate extends SortableEvent {
  chainIds: number[];
}

export interface LiteChainsIdListUpdate<ValueStore = number[]> extends GlobalConfigUpdate<ValueStore> {
  timestamp: number;
}