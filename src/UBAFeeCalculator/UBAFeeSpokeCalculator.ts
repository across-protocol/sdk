import { BigNumber } from "ethers";
import { TokenRunningBalance, UBAFlowRange, UbaFlow, isUbaInflow, isUbaOutflow } from "../interfaces";
import { toBN } from "../utils";
import UBAConfig, { ThresholdBoundType } from "./UBAFeeConfig";
import { getDepositBalancingFee, getRefundBalancingFee } from "./UBAFeeUtility";

/**
 * This file contains the implementation of the UBA Fee Spoke Calculator class. This class is
 * responsible for calculating the Universal Bridge Adapter fees for a given spoke. This class
 * contains a caching mechanism to avoid recomputing the running balance of the spoke for each
 * fee calculation.
 */
export default class UBAFeeSpokeCalculator {
  /**
   * The last validated running balance of the spoke
   */
  protected lastValidatedRunningBalance?: BigNumber;

  /**
   * The last incentive running balance of the spoke
   */
  protected lastValidatedIncentiveRunningBalance?: BigNumber;

  /**
   * The cached running balance of the spoke at each step in the recent request flow
   */
  private cachedRunningBalance: Record<string, TokenRunningBalance>;

  /**
   * Instantiates a new UBA Fee Spoke Store
   * @param chainId The chain id of the spoke
   * @param symbol The symbol of the token on the spoke
   * @param recentRequestFlow The recent request flow of the spoke
   * @param blockNumber The most recent block number
   */
  constructor(
    public readonly chainId: number,
    public readonly symbol: string,
    public readonly recentRequestFlow: UbaFlow[],
    public blockNumber: number,
    private readonly config: UBAConfig
  ) {
    this.lastValidatedRunningBalance = undefined;
    this.lastValidatedIncentiveRunningBalance = undefined;
    this.cachedRunningBalance = {};
  }

  /**
   * Calculates the historical running balance of the spoke from the last validated running balance
   * by aggregating the inflows and outflows of the spoke from the given starting step and extending
   * the aggregation for the given length.
   * @param startingStepFromLastValidatedBalance The starting step from the last validated balance. Defaults to 0.
   * @param lengthOfRunningBalance The length of the running balance. Defaults to the length of the recent request flow.
   * @returns The historical running balance
   */
  public calculateHistoricalRunningBalance(
    startingStepFromLastValidatedBalance?: number,
    lengthOfRunningBalance?: number
  ): TokenRunningBalance {
    const startIdx = startingStepFromLastValidatedBalance ?? 0;
    const length = lengthOfRunningBalance ?? this.recentRequestFlow.length + 1;
    const endIdx = startIdx + length;
    const key = `${startIdx}-${endIdx}`;

    // If the key is in the cache, return the cached value
    // We don't need to compute the running balance again
    if (key in this.cachedRunningBalance) {
      return this.cachedRunningBalance[key];
    }

    // Attempt to resolve the trigger hurdle to include in the running
    // balance calculation
    const { upperBound: upperBoundTriggerHurdle, lowerBound: lowerBoundTriggerHurdle } =
      this.getBalanceTriggerThreshold();

    // If the last validated running balance is undefined, we need to compute the running balance from scratch
    // This is the case when the UBA Fee Calculator is first initialized or run on a range
    // that we haven't computed the running balance for yet
    const historicalResult: TokenRunningBalance = this.recentRequestFlow.slice(startIdx, endIdx).reduce(
      (acc, flow) => {
        const resultant: TokenRunningBalance = { ...acc };

        if (isUbaInflow(flow)) {
          resultant.runningBalance = acc.runningBalance.add(flow.amount);
          resultant.incentiveBalance = acc.incentiveBalance.add(flow.amount);
        } else if (isUbaOutflow(flow)) {
          resultant.runningBalance = acc.runningBalance.sub(flow.amount);
          resultant.incentiveBalance = acc.incentiveBalance.sub(flow.amount);
        }

        // If the upper trigger hurdle is surpassed, we need to return the trigger hurdle value
        // as the running balance. This is because the trigger hurdle is the maximum value we'd like to
        // organically grow the running balance to. If the running balance exceeds the trigger hurdle,
        // we need to return the trigger hurdle as the running balance because at this point the dataworker
        // will be triggered to rebalance the running balance.
        if (upperBoundTriggerHurdle !== undefined && resultant.runningBalance.gt(upperBoundTriggerHurdle.threshold)) {
          resultant.runningBalance = upperBoundTriggerHurdle.target;
        }

        // If the lower trigger hurdle is surpassed, we need to return the trigger hurdle value
        // as the running balance. This is because the trigger hurdle is the minimum value we'd like to
        // organically shrink the running balance to. If the running balance is less than the trigger hurdle,
        // we need to return the trigger hurdle as the running balance because at this point the dataworker
        // will be triggered to rebalance the running balance.
        else if (
          lowerBoundTriggerHurdle !== undefined &&
          resultant.runningBalance.lt(lowerBoundTriggerHurdle.threshold)
        ) {
          resultant.runningBalance = lowerBoundTriggerHurdle.target;
        }

        return resultant;
      },
      {
        runningBalance: this.lastValidatedRunningBalance ?? toBN(0),
        incentiveBalance: this.lastValidatedIncentiveRunningBalance ?? toBN(0),
      }
    );

    // Cache the result
    this.cachedRunningBalance[key] = historicalResult;

    // Return the result
    return historicalResult;
  }

  /**
   * Calculates the recent running balance of the spoke by aggregating the inflows and outflows of the spoke
   * from the most recent block number to the most recent block number + 1. This is a convenience method for
   * calculateHistoricalRunningBalance with the default parameters of 0 and the length of the recent request flow.
   * @returns The recent running balance
   */
  public calculateRecentRunningBalance(): TokenRunningBalance {
    return this.calculateHistoricalRunningBalance(0, this.recentRequestFlow.length + 1);
  }

  /**
   * Clears the cached running balance of the spoke
   */
  public clearCachedRunningBalance(): void {
    this.cachedRunningBalance = {};
  }

  /**
   * A convenience method for resolving the balance trigger threshold for the spoke
   * and the given symbol
   * @returns The balance trigger threshold for the spoke and the given symbol
   * @see UBAConfig.getBalanceTriggerThreshold
   */
  public getBalanceTriggerThreshold(): ThresholdBoundType {
    return this.config.getBalanceTriggerThreshold(this.chainId, this.symbol);
  }

  /**
   * Calculates the fee for a simulated deposit operation
   * @param amount The amount of tokens to deposit
   * @param refundChainId The chain id of the refund spoke
   * @param flowRange The range of the flow to simulate the deposit for. Defaults to undefined to simulate the deposit for the entire flow.
   * @returns The fee for the simulated deposit operation
   */
  public getDepositFee(amount: BigNumber, refundChainId: number, flowRange?: UBAFlowRange): BigNumber {
    let depositorFee = toBN(0);

    // Resolve the alpha fee of this action
    const alphaFee = this.config.getBaselineFee(this.chainId, refundChainId);

    // Contribute the alpha fee to the LP fee
    depositorFee = depositorFee.add(alphaFee);

    // Resolve the historical running balance of the spoke
    const depositRunningBalance = this.calculateHistoricalRunningBalance(flowRange?.startIndex, flowRange?.endIndex);

    // Resolve the balancing fee tuples that are relevant to this operation
    const originBalancingFeeTuples = this.config.getBalancingFeeTuples(this.chainId);

    depositorFee = depositorFee.add(
      getDepositBalancingFee(originBalancingFeeTuples, depositRunningBalance.runningBalance, amount)
    );

    return depositorFee;
  }

  /**
   * Calculates the fee for a simulated refund operation
   * @param amount The amount of tokens to refund
   * @param _depositChainId The chain id of the deposit spoke
   * @param flowRange The range of the flow to simulate the refund for. Defaults to undefined to simulate the refund for the entire flow.
   * @returns The fee for the simulated refund operation
   */
  public getRefundFee(amount: BigNumber, _depositChainId: number, flowRange?: UBAFlowRange): BigNumber {
    let refundFee = toBN(0);

    // Resolve the utilization fee
    const utilizationFee = this.config.getUtilizationFee();

    // Contribute the utilization fee to the Relayer fee
    refundFee = refundFee.add(utilizationFee);

    // Resolve the running balance of the spoke at the given step
    const refundRunningBalance = this.calculateHistoricalRunningBalance(flowRange?.startIndex, flowRange?.endIndex);

    // Resolve the balancing fee tuples that are relevant to this operation
    const refundBalancingFeeTuples = this.config.getBalancingFeeTuples(this.chainId);

    refundFee = refundFee.add(
      getRefundBalancingFee(refundBalancingFeeTuples, refundRunningBalance.runningBalance, amount)
    );

    return refundFee;
  }
}
