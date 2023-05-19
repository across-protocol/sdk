import { BigNumber } from "ethers";

type ChainId = number;
type RouteCombination = string;
type ChainTokenCombination = string;

export type TupleParameter = [BigNumber, BigNumber];
export type ThresholdType = { target: BigNumber; threshold: BigNumber };
export type ThresholdBoundType = Partial<{ lowerBound: ThresholdType; upperBound: ThresholdType }>;
type DefaultOverrideStructure<PrimaryValue, OverrideKeyType extends string | number | symbol> = {
  default: PrimaryValue;
  override?: Record<OverrideKeyType, PrimaryValue>;
};
type FlowTupleParameters = { inflow: TupleParameter[]; outflow: TupleParameter[] };

/**
 * Defines the configuration needed to calculate the UBA fees
 */
class UBAConfig {
  /**
   * A baseline fee that is applied to all transactions to allow LPs to earn a fee
   */
  private readonly baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>;
  /**
   * A record of piecewise functions for each chain that define the utilization fee to ensure that
   * the bridge responds to periods of high utilization
   */
  private readonly utilizationFee: BigNumber;
  /**
   * A record of piecewise functions for each chain and token that define the balancing fee to ensure
   * either a positive or negative penalty to bridging a token to a chain that is either under or
   * over utilized
   */
  private readonly balancingFee: DefaultOverrideStructure<FlowTupleParameters, ChainId>;

  /**
   * A record of boundry values for each chain and token that define the threshold for when the
   * running balance should be balanced back to a fixed amount. Due to the fact that this type of
   * operation is based on a heuristic and is considered a non-event transient property of the
   * protocol, the threshold must be computed based on the current running balance of the spoke from
   * the last validated running balance.
   */
  private readonly balanceTriggerThreshold: Record<ChainTokenCombination, ThresholdBoundType>;

  /**
   * Instantiate a new UBA Config object
   * @param baselineFee A baseline fee that is applied to all transactions to allow LPs to earn a fee
   * @param utilizationFee A record of piecewise functions for each chain that define the utilization fee to ensure that the bridge responds to periods of high utilization
   * @param balancingFee A record of piecewise functions for each chain and token that define the balancing fee to ensure either a positive or negative penalty to bridging a token to a chain that is either under or over utilized
   * @param balanceTriggerThreshold A record of boundry values for each chain and token that define the threshold for when the running balance should be balanced back to a fixed amount. Due to the fact that this type of operation is based on a heuristic and is considered a non-event transient property of the protocol, the threshold must be computed based on the current running balance of the spoke from the last validated running balance.
   */
  constructor(
    baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>,
    utilizationFee: BigNumber,
    balancingFee: DefaultOverrideStructure<FlowTupleParameters, ChainId>,
    balanceTriggerThreshold: Record<ChainTokenCombination, ThresholdBoundType>
  ) {
    this.baselineFee = baselineFee;
    this.utilizationFee = utilizationFee;
    this.balancingFee = balancingFee;
    this.balanceTriggerThreshold = balanceTriggerThreshold;
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
   * @description Get the utilization fee for a given chain
   * @returns The utilization fee
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public getUtilizationFee(): BigNumber {
    return this.utilizationFee;
  }

  /**
   * @description Get the balancing fee tuples for a given chain
   *  @param chainId The chain id
   * @returns The balancing fee
   */
  public getBalancingFeeTuples(chainId: number): FlowTupleParameters {
    return this.balancingFee.override?.[chainId] ?? this.balancingFee.default;
  }

  /**
   * @description Get the balance trigger threshold for a given chain and token
   * @param chainId The chain id
   * @param tokenSymbol The token address
   * @returns The balance trigger threshold if it exists
   */
  public getBalanceTriggerThreshold(chainId: number, tokenSymbol: string): ThresholdBoundType {
    const chainTokenCombination = `${chainId}-${tokenSymbol}`;
    return this.balanceTriggerThreshold[chainTokenCombination] ?? {};
  }
}

export default UBAConfig;
