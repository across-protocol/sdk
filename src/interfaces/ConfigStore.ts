import { BigNumber } from "ethers";
import { RateModelDictionary } from "../lpFeeCalculator/rateModel";
import { SortableEvent } from "./Common";

export interface ParsedTokenConfig {
  rateModel: RateModelDictionary;
  routeRateModel?: {
    [path: string]: RateModelDictionary;
  };
  uba?: UBAOnChainConfigType;
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

/**
 * A generic type of a dictionary that has string keys and values of type T. This
 * record is enforced to have a default entry within the "default" key.
 * @type Value The type of the values in the dictionary.
 */
type RecordWithDefaultEntry<Value> = Record<string, Value>;

/**
 * A generic type for an array of tuples.
 * @type Value The type of the values in the array.
 */
type ArrayOfTuples<Value> = [Value, Value][];

/**
 * A type for the UBA config object stored both on and off chain.
 * @type T The type of the values in the config.
 * @note This is a dictionary of parameters that defines a fee curve for the token.
 *       These parameters can be further subindexed by a route (e.g. using the key "1-10" or "42161-1")
 *       to create a specific fee curve for a token per route. The subkeys are as followed:
 *         - alpha: The alpha parameter of the fee curve.
 *         - gamma: The gamma parameter of the fee curve.
 *         - omega: The omega parameter of the fee curve.
 *         - rebalance: The rebalance parameters of the fee curve.
 */
type UBAAgnosticConfigType<T> = {
  /**
   * A DAO controlled variable to track any donations made to the incentivePool liquidity
   */
  incentivePoolAdjustment?: Record<string, T>;
  /**
   * Used to scale rewards when a fee is larger than the incentive balance
   */
  ubaRewardMultiplier?: Record<string, T>;
  /**
   * This is a scalar value that is a constant percentage of each transfer that is allocated for LPs.
   * This value can be determined by token and route-by-route.
   */
  alpha: RecordWithDefaultEntry<T>;
  /**
   * This is a piecewise linear function (defined by a vector of cut-off points and the values at
   * those points) that determine additional LP fees as a function of utilization. This piecewise
   * linear function can be determined by token and chain-by-chain.
   */
  gamma: RecordWithDefaultEntry<ArrayOfTuples<T>>;
  /**
   * This is a piecewise linear function (defined by a vector of cut-off points and the values at
   * those points) that determine the balancing fees (rewards) that are imposed on (paid to) a user
   * who makes a transfer involving a particular chain. There is a single piecewise linear function for
   * each token/chain combination. A transfer will incur a balancing fee on both the origin and destination
   * chains.
   */
  omega: RecordWithDefaultEntry<ArrayOfTuples<T>>;
  /**
   * This is a set of parameters that determine when a rebalance is triggered. A rebalance is triggered
   * when the utilization of a pool is outside of the range defined by the lower and upper thresholds.
   */
  rebalance: RecordWithDefaultEntry<{
    /**
     * For tokens/chains that have a supported bridge, these are the lower and upper threshold that trigger
     * the reallocation of funds. i.e. If the running balance on a chain moves below (above) threshold_lower
     * (threshold_upper) then the bridge moves funds from Ethereum to the chain (from the chain to Ethereum).
     */
    threshold_lower?: T;
    /**
     * For tokens/chains that have a supported bridge, these are the lower and upper threshold that trigger
     * the reallocation of funds. i.e. If the running balance on a chain moves below (above) threshold_lower
     * (threshold_upper) then the bridge moves funds from Ethereum to the chain (from the chain to Ethereum).
     */
    threshold_upper?: T;
    /**
     * For tokens/chains that have a supported bridge, these are the values that are targeted whenever funds
     * are reallocated.
     */
    target_lower?: T;
    /**
     * For tokens/chains that have a supported bridge, these are the values that are targeted whenever funds
     * are reallocated.
     */
    target_upper?: T;
  }>;
};

/**
 * A type for the UBA config object stored on chain.
 */
export type UBAOnChainConfigType = UBAAgnosticConfigType<string>;

/**
 * A type for the UBA config object after it has been parsed.
 */
export type UBAParsedConfigType = UBAAgnosticConfigType<BigNumber>;

/**
 * A type for UBAConfig Update events.
 */
export type UBAConfigUpdates = SortableEvent & {
  config: UBAParsedConfigType;
  l1Token: string;
};

/**
 * A type for stringified UBAConfig Update events.
 */
export type UBASerializedConfigUpdates = SortableEvent & {
  config: UBAOnChainConfigType;
  l1Token: string;
};
