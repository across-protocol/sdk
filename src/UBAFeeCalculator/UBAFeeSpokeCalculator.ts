import { BigNumber } from "ethers";
import { TokenRunningBalance, UBAFlowRange, UbaFlow, isUbaInflow } from "../interfaces";
import { toBN } from "../utils";
import UBAConfig, { ThresholdBoundType } from "./UBAFeeConfig";
import { computePiecewiseLinearFunction } from "./UBAFeeUtility";

type TokenRunningBalanceWithNetSend = TokenRunningBalance & {
  netRunningBalanceAdjustment: BigNumber;
};

type FlowFee = {
  balancingFee: BigNumber;
};

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
  private cachedRunningBalance: Record<string, TokenRunningBalanceWithNetSend>;

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
  ): TokenRunningBalanceWithNetSend {
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
    const historicalResult: TokenRunningBalanceWithNetSend = this.recentRequestFlow.slice(startIdx, endIdx).reduce(
      (acc, flow) => {
        // If the flow is an inflow, we need to add the amount to the running balance
        // If the flow is an outflow, we need to subtract the amount from the running balance
        // This is reflected in the incentive balance as well
        const resultant: TokenRunningBalanceWithNetSend = {
          netRunningBalanceAdjustment: toBN(acc.netRunningBalanceAdjustment.toString()), // Deep copy via string conversion
          runningBalance: acc.runningBalance[isUbaInflow(flow) ? "add" : "sub"](flow.amount),
          incentiveBalance: acc.incentiveBalance[isUbaInflow(flow) ? "add" : "sub"](flow.amount), // TODO: Add correct incentive balance calculations
        };

        // If the upper trigger hurdle is surpassed, we need to return the trigger hurdle value
        // as the running balance. This is because the trigger hurdle is the maximum value we'd like to
        // organically grow the running balance to. If the running balance exceeds the trigger hurdle,
        // we need to return the trigger hurdle as the running balance because at this point the dataworker
        // will be triggered to rebalance the running balance.
        if (upperBoundTriggerHurdle !== undefined && resultant.runningBalance.gt(upperBoundTriggerHurdle.threshold)) {
          // Update the net running balance adjustment to reflect the difference between the running balance
          // and the trigger hurdle
          resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.add(
            resultant.runningBalance.sub(upperBoundTriggerHurdle.target)
          );
          // Set the running balance to the trigger hurdle
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
          // Update the net running balance adjustment to reflect the difference between the running balance
          // and the trigger hurdle
          resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.add(
            lowerBoundTriggerHurdle.target.sub(resultant.runningBalance)
          );
          // Set the running balance to the trigger hurdle
          resultant.runningBalance = lowerBoundTriggerHurdle.target;
        }

        return resultant;
      },
      {
        runningBalance: this.lastValidatedRunningBalance ?? toBN(0),
        incentiveBalance: this.lastValidatedIncentiveRunningBalance ?? toBN(0),
        netRunningBalanceAdjustment: toBN(0),
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
   * A convenience method for resolving the event fee for the spoke and the given symbol and a given flow type
   * @param amount The amount of tokens to simulate
   * @param flowType The flow type to simulate
   * @param flowRange The range of the flow to simulate the event for. Defaults to undefined to simulate the event for the entire flow.
   * @returns The event fee for the spoke and the given symbol and a given flow type
   */
  protected getEventFee(amount: BigNumber, flowType: "inflow" | "outflow", flowRange?: UBAFlowRange): FlowFee {
    // The rough psuedocode for this function is as follows:
    // We'll need two inflow/outflow curves
    // We need to determine which flow curve to use based on the flow type
    // Compute first balancing fee <- f(x, x+amnt)
    // Compute second balance fee (oportunity cost) <- g(x+amnt, x)
    // Incentive Fee (LP Fee Component): first balancing fee - second balance fee
    // Return (LP Fee + Balancing Fee)
    // #############################################

    // We'll need to now compute the concept of the running balance of the spoke
    const { runningBalance } = this.calculateHistoricalRunningBalance(flowRange?.startIndex, flowRange?.endIndex);

    // We first need to resolve the inflow/outflow curves for the deposit and refund spoke
    const flowCurve = this.config.getBalancingFeeTuples(this.chainId);

    // Next, we'll need to compute the first balancing fee from the running balance of the spoke
    // to the running balance of the spoke + the amount
    const balancingFee = computePiecewiseLinearFunction(
      flowCurve,
      runningBalance,
      amount.mul(flowType === "inflow" ? 1 : -1)
    );

    // We can now return the fee
    return {
      balancingFee,
    };
  }

  /**
   * Calculates the fee for a simulated deposit operation
   * @param amount The amount of tokens to deposit
   * @param flowRange The range of the flow to simulate the deposit for. Defaults to undefined to simulate the deposit for the entire flow.
   * @returns The fee for the simulated deposit operation
   */
  public getDepositFee(amount: BigNumber, flowRange?: UBAFlowRange): FlowFee {
    return this.getEventFee(amount, "inflow", flowRange);
  }

  /**
   * Calculates the fee for a simulated refund operation
   * @param amount The amount of tokens to refund
   * @param flowRange The range of the flow to simulate the refund for. Defaults to undefined to simulate the refund for the entire flow.
   * @returns The fee for the simulated refund operation
   */
  public getRefundFee(amount: BigNumber, flowRange?: UBAFlowRange): FlowFee {
    return this.getEventFee(amount, "outflow", flowRange);
  }
}
