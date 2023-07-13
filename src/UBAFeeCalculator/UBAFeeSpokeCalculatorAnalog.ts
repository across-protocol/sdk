/** Provides the static, procedural versions of the functions provided in the UBAFeeSpokeCalculator */

import { BigNumber } from "ethers";
import { UbaFlow, isUbaInflow } from "../interfaces";
import { TokenRunningBalanceWithNetSend, UBAActionType, UBAFlowFee } from "./UBAFeeTypes";
import UBAConfig from "./UBAFeeConfig";
import { min, toBN } from "../utils";
import { computePiecewiseLinearFunction } from "./UBAFeeUtility";

/**
 * Calculates the running balances for a given token on a spoke chain produced by the set of flows and beginning with
 * the validated running balances.
 * @param flows The flows to calculate the running balance for.
 * @param lastValidatedRunningBalance The last validated running balance for the token and chain ID validated in
 * a root bundle in the HubPool.
 * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance for the token and chain ID
 * validated in a root bundle in the HubPool.
 * @param chainId The chain id of the spoke chain
 * @param tokenSymbol The token symbol of the token to calculate the running balance for
 * @param config The UBAConfig to use for the calculation. This must apply to all `flows`.
 * @returns The running balance for the token
 */
export function calculateHistoricalRunningBalance(
  flows: UbaFlow[],
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  tokenSymbol: string,
  config: UBAConfig
): TokenRunningBalanceWithNetSend {
  // Attempt to resolve the trigger hurdle to include in the running
  // balance calculation
  const { upperBound: upperBoundTriggerHurdle, lowerBound: lowerBoundTriggerHurdle } =
    config.getBalanceTriggerThreshold(chainId, tokenSymbol);

  const historicalResult: TokenRunningBalanceWithNetSend = flows.reduce(
    (acc, flow) => {
      // Compute the balancing fee for the flow. This depends on the running balance as of this flow, which
      // is essentially the lastValidatedRunningBalance plus any accumulations from the flows preceding this one.
      const { balancingFee: incentiveFee } = getEventFee(
        flow.amount,
        isUbaInflow(flow) ? "inflow" : "outflow",
        acc.runningBalance,
        acc.incentiveBalance,
        chainId,
        config
      );

      // Now, add this flow's amount to the accumulated running balance.
      // If the flow is an inflow, we need to add the amount to the running balance
      // If the flow is an outflow, we need to subtract the amount from the running balance
      // This is reflected in the incentive balance as well
      const resultant: TokenRunningBalanceWithNetSend = {
        netRunningBalanceAdjustment: toBN(acc.netRunningBalanceAdjustment.toString()), // Deep copy via string conversion
        runningBalance: acc.runningBalance[isUbaInflow(flow) ? "add" : "sub"](flow.amount).sub(incentiveFee),
        incentiveBalance: acc.incentiveBalance[isUbaInflow(flow) ? "add" : "sub"](flow.amount).add(incentiveFee),
      };

      // If the upper trigger hurdle is surpassed, we need to return the trigger hurdle value
      // as the running balance. This is because the trigger hurdle is the maximum value we'd like to
      // organically grow the running balance to. If the running balance exceeds the trigger hurdle,
      // we need to return the trigger hurdle as the running balance because at this point the dataworker
      // will be triggered to rebalance the running balance.
      if (upperBoundTriggerHurdle !== undefined && resultant.runningBalance.gt(upperBoundTriggerHurdle.threshold)) {
        // If we are over the target, subtract the difference from the net running balance adjustment
        // so that the dataworker can instruct the spoke pool to return funds to the hub pool.
        resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.sub(
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
        // If we are under the target, add the difference to the net running balance adjustment
        // so that the dataworker can instruct the hub pool to send funds to the spokepool.
        resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.add(
          lowerBoundTriggerHurdle.target.sub(resultant.runningBalance)
        );
        // Set the running balance to the trigger hurdle
        resultant.runningBalance = lowerBoundTriggerHurdle.target;
      }

      return resultant;
    },
    {
      runningBalance: lastValidatedRunningBalance ?? toBN(0),
      incentiveBalance: lastValidatedIncentiveRunningBalance ?? toBN(0),
      netRunningBalanceAdjustment: toBN(0),
    }
  );
  // Return the result
  return historicalResult;
}

/**
 * Returns the balancing fee for a given event that produces a flow of `flowType` of size `amount`.
 * @param amount Amount of inflow or outflow produced by event that we're computing a balancing fee for.
 * @param flowType Inflow or Outflow.
 * @param lastRunningBalance The latest running balance preceding this event.
 * @param lastIncentiveBalance The latest incentive balance preceding this event.
 * @param chainId The chain id of the spoke chain
 * @param config The UBAConfig to use for the calculation
 * @returns
 */
export function getEventFee(
  amount: BigNumber,
  flowType: "inflow" | "outflow",
  lastRunningBalance: BigNumber,
  lastIncentiveBalance: BigNumber,
  chainId: number,
  config: UBAConfig
): UBAFlowFee {
  // The rough psuedocode for this function is as follows:
  // We'll need two inflow/outflow curves
  // We need to determine which flow curve to use based on the flow type
  // Compute first balancing fee <- f(x, x+amnt)
  // Compute second balance fee (oportunity cost) <- g(x+amnt, x)
  // Incentive Fee (LP Fee Component): first balancing fee - second balance fee
  // Return (LP Fee + Balancing Fee)
  // #############################################

  // We first need to resolve the inflow/outflow curves for the deposit and refund spoke
  const flowCurve = config.getBalancingFeeTuples(chainId);

  // Next, we'll need to compute the first balancing fee from the running balance of the spoke
  // to the running balance of the spoke + the amount
  let balancingFee = computePiecewiseLinearFunction(
    flowCurve,
    lastRunningBalance,
    amount.mul(flowType === "inflow" ? 1 : -1)
  );

  // Apply hardcoded multiplier if incentive fee is a reward instead of a penalty
  if (balancingFee.gt(0)) {
    // This should never error. `getUbaRewardMultiplier` should default to 1
    balancingFee = balancingFee.mul(config.getUbaRewardMultiplier(chainId.toString()));
  }

  // if the chainId is not found in the config
  // If P << uncappedIncentiveFee, discountFactor approaches 100%. Capped at 100%
  if (balancingFee.gt(lastIncentiveBalance)) {
    const discountFactor = min(BigNumber.from(1), balancingFee.sub(lastIncentiveBalance).div(balancingFee));
    balancingFee = balancingFee.mul(BigNumber.from(1).sub(discountFactor));
  }

  // We can now return the fee
  return {
    balancingFee,
  };
}

/**
 * Calculates the fee for a deposit on a spoke chain
 * @param amount The amount of the deposit
 * @param lastValidatedRunningBalance The last validated running balance of the spoke
 * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance of the spoke
 * @param chainId The chain id of the spoke chain
 * @param config The UBAConfig to use for the calculation
 * @returns The fee for the deposit
 * @see getEventFee
 */
export function getDepositFee(
  amount: BigNumber,
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  config: UBAConfig
): UBAFlowFee {
  return getEventFee(
    amount,
    "inflow",
    lastValidatedRunningBalance,
    lastValidatedIncentiveRunningBalance,
    chainId,
    config
  );
}

/**
 * Calculates the fee for a refund on a spoke chain
 * @param amount The amount of the refund
 * @param lastValidatedRunningBalance The last validated running balance of the spoke
 * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance of the spoke
 * @param chainId The chain id of the spoke chain
 * @param config The UBAConfig to use for the calculation
 * @returns The fee for the refund
 * @see getEventFee
 */
export function getRefundFee(
  amount: BigNumber,
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  config: UBAConfig
): UBAFlowFee {
  return getEventFee(
    amount,
    "outflow",
    lastValidatedRunningBalance,
    lastValidatedIncentiveRunningBalance,
    chainId,
    config
  );
}

/**
 * A convenience lookup table for the fee calculation functions
 * @see getDepositFee
 * @see getRefundFee
 * @see getEventFee
 */
export const feeCalculationFunctionsForUBA: Record<UBAActionType, typeof getDepositFee | typeof getRefundFee> = {
  deposit: getDepositFee,
  refund: getRefundFee,
};
