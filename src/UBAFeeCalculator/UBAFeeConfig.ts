import { BigNumber } from "ethers";
import { ThresholdBoundType, FlowTupleParameters } from "./UBAFeeTypes";
import { CHAIN_ID_LIST_INDICES, HUBPOOL_CHAIN_ID } from "../constants";

type ChainId = number;
type RouteCombination = string;
type ChainTokenCombination = string;
type DefaultOverrideStructure<PrimaryValue, OverrideKeyType extends string | number | symbol> = {
  default: PrimaryValue;
  override?: Record<OverrideKeyType, PrimaryValue>;
};

/**
 * Defines the configuration needed to calculate the UBA fees
 */
class UBAConfig {
  /**
   * A baseline fee that is applied to all transactions to allow LPs to earn a fee
   */
  protected readonly baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>;
  /**
   * A record of piecewise functions for each chain and token that define the balancing fee to ensure
   * either a positive or negative penalty to bridging a token to a chain that is either under or
   * over utilized
   */
  protected readonly balancingFee: DefaultOverrideStructure<FlowTupleParameters, ChainId>;

  /**
   * A record of boundry values for each chain and token that define the threshold for when the
   * running balance should be balanced back to a fixed amount. Due to the fact that this type of
   * operation is based on a heuristic and is considered a non-event transient property of the
   * protocol, the threshold must be computed based on the current running balance of the spoke from
   * the last validated running balance.
   */
  protected readonly balanceTriggerThreshold: DefaultOverrideStructure<ThresholdBoundType, ChainTokenCombination>;

  /**
   * A record of piecewise functions for each chain that define the utilization fee to ensure that
   * the bridge responds to periods of high utilization. We can integrate over this function to
   * find the realized lp percent fee.
   */
  protected readonly lpGammaFunction: DefaultOverrideStructure<FlowTupleParameters, ChainId>;

  /**
   * A DAO controlled variable to track any donations made to the incentivePool liquidity
   */
  protected readonly incentivePoolAdjustment: Record<string, BigNumber>;

  /**
   * Used to scale rewards when a fee is larger than the incentive balance
   */
  protected readonly ubaRewardMultiplier: Record<string, BigNumber>;

  /**
   * Instantiate a new UBA Config object
   * @param baselineFee A baseline fee that is applied to all transactions to allow LPs to earn a fee
   * @param balancingFee A record of piecewise functions for each chain and token that define the balancing fee to ensure either a positive or negative penalty to bridging a token to a chain that is either under or over utilized
   * @param balanceTriggerThreshold A record of boundry values for each chain and token that define the threshold for when the running balance should be balanced back to a fixed amount. Due to the fact that this type of operation is based on a heuristic and is considered a non-event transient property of the protocol, the threshold must be computed based on the current running balance of the spoke from the last validated running balance.
   * @param lpGammaFunction A record of piecewise functions for each chain that define the utilization fee to ensure that the bridge responds to periods of high utilization
   * @param incentivePoolAdjustment A DAO controlled variable to track any donations made to the incentivePool liquidity
   * @param ubaRewardMultiplier Used to scale rewards when a fee is larger than the incentive balance
   */
  constructor(
    baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>,
    balancingFee: DefaultOverrideStructure<FlowTupleParameters, ChainId>,
    balanceTriggerThreshold: DefaultOverrideStructure<ThresholdBoundType, ChainTokenCombination>,
    lpGammaFunction: DefaultOverrideStructure<FlowTupleParameters, ChainId>,
    incentivePoolAdjustment: Record<string, BigNumber> = {},
    ubaRewardMultiplier: Record<string, BigNumber> = {}
  ) {
    this.baselineFee = baselineFee;
    this.balancingFee = balancingFee;
    this.balanceTriggerThreshold = balanceTriggerThreshold;
    this.lpGammaFunction = lpGammaFunction;
    this.incentivePoolAdjustment = incentivePoolAdjustment;
    this.ubaRewardMultiplier = ubaRewardMultiplier;
  }

  /**
   * @description Get the baseline fee for a given route combination
   * @param destinationChainId The destination chain id
   * @param originChainId The origin chain id
   * @returns The baseline fee
   */
  public getBaselineFee(destinationChainId: number, originChainId: number): BigNumber {
    const routeCombination = `${originChainId}-${destinationChainId}`;
    return this.baselineFee.override?.[routeCombination] ?? this.baselineFee.default;
  }

  /**
   * @description Get the balancing fee tuples for a given chain
   * @param chainId The chain id
   * @returns The balancing fee
   */
  public getBalancingFeeTuples(chainId: number): FlowTupleParameters {
    return this.balancingFee.override?.[chainId] ?? this.balancingFee.default;
  }

  /**
   * @description Get the lp gamma function tuples for a given chain
   * @param chainId The chain id
   * @returns The lp gamma function
   */
  public getLpGammaFunctionTuples(chainId: number): FlowTupleParameters {
    return this.lpGammaFunction.override?.[chainId] ?? this.lpGammaFunction.default;
  }

  /**
   * @description Get the balance trigger threshold for a given chain and token
   * @param chainId The chain id
   * @param l1TokenAddress The token address
   * @returns The balance trigger threshold if it exists
   */
  public getBalanceTriggerThreshold(chainId: number, l1TokenAddress: string): ThresholdBoundType {
    const chainTokenCombination = `${chainId}-${l1TokenAddress}`;
    return this.balanceTriggerThreshold.override?.[chainTokenCombination] ?? this.balanceTriggerThreshold.default;
  }

  /**
   * Arbitrarily return upper bound target. This could be the average of the upper and lower bound targets but
   * for now return upper bound target.
   * @param chainId
   * @param l1TokenAddress
   * @returns
   */
  public getTargetBalance(chainId: number, l1TokenAddress: string): BigNumber {
    const thresholdConfig = this.getBalanceTriggerThreshold(chainId, l1TokenAddress);
    return thresholdConfig?.upperBound?.target ?? BigNumber.from(0);
  }

  /**
   * Get sum of all spoke target balances for all chains besides hub pool chain for l1TokenAddress.
   * This output should be used to compute LP fee based on total spoke target
   */
  public getTotalSpokeTargetBalanceForComputingLpFee(l1TokenAddress: string): BigNumber {
    return CHAIN_ID_LIST_INDICES.filter((chainId) => chainId !== HUBPOOL_CHAIN_ID).reduce((sum, chainId) => {
      return sum.add(this.getTargetBalance(chainId, l1TokenAddress));
    }, BigNumber.from(0));
  }

  /**
   * Get the incentive pool adjustment
   * @param chainId The chain id
   * @returns The incentive pool adjustment. Defaults to 0 if not set
   */
  public getIncentivePoolAdjustment(chainId: string): BigNumber {
    return this.incentivePoolAdjustment?.[chainId] ?? BigNumber.from(0); // Default to 0 if not set
  }

  /**
   * Get the UBA reward multiplier
   * @param chainId The chain id
   * @returns The UBA reward multiplier. Defaults to 1 if not set
   */
  public getUbaRewardMultiplier(chainId: string): BigNumber {
    return this.ubaRewardMultiplier?.[chainId] ?? BigNumber.from(1); // Default to 1 if not set
  }
}

export default UBAConfig;
