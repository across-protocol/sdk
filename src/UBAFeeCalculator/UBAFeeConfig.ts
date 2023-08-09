import { BigNumber, ethers } from "ethers";
import { ThresholdBoundType, FlowTupleParameters } from "./UBAFeeTypes";
import { stringifyJSONWithNumericString } from "../utils/JSONUtils";
import { fixedPointAdjustment } from "../utils";
import { assertValidityOfFeeCurve } from "./UBAFeeUtility";

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
   * @throws Error if any of the fee curves are invalid and assertValidityOfFeeCurves is true
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

    // Validate the config
    this.assertValidityOfAllFeeCurves();
  }

  /**
   * Assert the validity of all fee curves. This is a helper function
   * that is called in the constructor to ensure that all fee curves
   * are valid.
   */
  private assertValidityOfAllFeeCurves(): void {
    // Find all the fee curves that could possibiliy be used
    // in the UBA fee calculation. Specifically, these are the
    // balancing fee curve and the lp gamma function curve. The
    // curves are available for all overrides as well as their
    // default counterparts.
    const omega = [this.balancingFee.default, ...Object.values(this.balancingFee.override ?? {})];
    const gamma = [this.lpGammaFunction.default, ...Object.values(this.lpGammaFunction.override ?? {})];
    // Iterate through each curve and assert that it is valid
    omega.forEach((f) => assertValidityOfFeeCurve(f, true));
    gamma.forEach((f) => assertValidityOfFeeCurve(f, false));
  }

  /**
   * @description Get the baseline fee for a given route combination
   * @param destinationChainId The destination chain id
   * @param originChainId The origin chain id
   * @returns The baseline fee
   */
  public getBaselineFee(destinationChainId: number, originChainId: number): BigNumber {
    return (
      this.baselineFee.override?.[`${originChainId}-${destinationChainId}`] ??
      this.baselineFee.override?.[`${destinationChainId}-${originChainId}`] ??
      this.baselineFee.default ??
      ethers.constants.Zero
    );
  }

  /**
   * @description Get the balancing fee tuples for a given chain
   * @param chainId The chain id
   * @returns The balancing fee
   */
  public getBalancingFeeTuples(chainId: number): FlowTupleParameters {
    return this.balancingFee.override?.[chainId] ?? this.balancingFee.default;
  }

  public getZeroFeePointOnBalancingFeeCurve(chainId: number): BigNumber {
    const balancingFeeTuples = this.getBalancingFeeTuples(chainId);
    const zeroPoint = balancingFeeTuples.find((tuple) => tuple[1].eq(0));
    if (!zeroPoint) {
      throw new Error(`No zero point on balancing fee curve for chain ${chainId}`);
    }
    return zeroPoint[0];
  }

  public isBalancingFeeCurveFlatAtZero(chainId: number): boolean {
    const balancingFeeCurve = this.getBalancingFeeTuples(chainId);
    return balancingFeeCurve.length === 1 && balancingFeeCurve[0][0].eq(0) && balancingFeeCurve[0][1].eq(0);
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
   * @param tokenSymbol The symbol of the token which will be resolved
   * @returns The balance trigger threshold if it exists
   */
  public getBalanceTriggerThreshold(chainId: number, tokenSymbol: string): ThresholdBoundType {
    const chainTokenCombination = `${chainId}-${tokenSymbol}`;
    return (
      this.balanceTriggerThreshold.override?.[chainTokenCombination] ??
      this.balanceTriggerThreshold.default ?? {
        upperBound: {}, // Default to empty object if not set
        lowerBound: {}, // Default to empty object if not set
      }
    );
  }

  /**
   * Arbitrarily return upper bound target. This could be the average of the upper and lower bound targets but
   * for now return upper bound target.
   * @param chainId
   * @param l1TokenAddress
   * @returns
   */
  public getTargetBalance(chainId: number, tokenSymbol: string): BigNumber {
    const thresholdConfig = this.getBalanceTriggerThreshold(chainId, tokenSymbol);
    return thresholdConfig?.upperBound?.target ?? ethers.constants.Zero;
  }

  /**
   * Get the incentive pool adjustment
   * @param chainId The chain id
   * @returns The incentive pool adjustment. Defaults to 0 if not set
   */
  public getIncentivePoolAdjustment(chainId: string): BigNumber {
    return this.incentivePoolAdjustment?.[chainId] ?? ethers.constants.Zero; // Default to 0 if not set
  }

  /**
   * Get the UBA reward multiplier
   * @param chainId The chain id
   * @returns The UBA reward multiplier. Defaults to 1 if not set
   */
  public getUbaRewardMultiplier(chainId: string): BigNumber {
    return this.ubaRewardMultiplier?.[chainId] ?? fixedPointAdjustment; // Default to 1 if not set
  }

  public toJSON() {
    return {
      baselineFee: JSON.parse(stringifyJSONWithNumericString(this.baselineFee)),
      balancingFee: JSON.parse(stringifyJSONWithNumericString(this.balancingFee)),
      balanceTriggerThreshold: JSON.parse(stringifyJSONWithNumericString(this.balanceTriggerThreshold)),
      lpGammaFunction: JSON.parse(stringifyJSONWithNumericString(this.lpGammaFunction)),
      incentivePoolAdjustment: JSON.parse(stringifyJSONWithNumericString(this.incentivePoolAdjustment)),
      ubaRewardMultiplier: JSON.parse(stringifyJSONWithNumericString(this.ubaRewardMultiplier)),
    };
  }
}

export default UBAConfig;
