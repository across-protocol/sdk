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
 * @param flows The flows to calculate the running balance for. These must all be within the same root bundle period
 * follows the one that snapshotted the last validated running balances.
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

  // If the last validated running balance is undefined, we need to compute the running balance from scratch
  // This is the case when the UBA Fee Calculator is first initialized or run on a range
  // that we haven't computed the running balance for yet
  const historicalResult: TokenRunningBalanceWithNetSend = flows.reduce(
    (acc, flow, idx, arr) => {
      // Compute the balancing fee for the flow
      // We are going to use as the fill-in for the incentive fee. We must compute it here
      // because the incentive fee is dependent on the running balance of the spoke
      // and we need to compute the fee on the previous flows not including the current flow
      const { balancingFee: incentiveFee } = getEventFee(
        flow.amount,
        isUbaInflow(flow) ? "inflow" : "outflow",
        arr.slice(0, idx),
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        chainId,
        tokenSymbol,
        config
      );

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
 * @param previousFlows The set of flows that precede the input event that are older than the last validated root
 * bundle.
 * @param lastValidatedRunningBalance The last validated running balance for the token and chain ID validated in
 * a root bundle. This is used only to pass back to the `calculateHistoricalRunningBalance` function in order to
 * compute the latest running balances prior to this event.
 * @param lastValidatedIncentiveRunningBalance See comment for `lastValidatedRunningBalance`.
 * @param chainId
 * @param tokenSymbol
 * @param config
 * @returns
 */
export function getEventFee(
  amount: BigNumber,
  flowType: "inflow" | "outflow",
  previousFlows: UbaFlow[],
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  tokenSymbol: string,
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

  // We'll need to now compute the concept of the running balance of the spoke
  const { runningBalance, incentiveBalance } = calculateHistoricalRunningBalance(
    previousFlows,
    lastValidatedRunningBalance,
    lastValidatedIncentiveRunningBalance,
    chainId,
    tokenSymbol,
    config
  );

  // We first need to resolve the inflow/outflow curves for the deposit and refund spoke
  const flowCurve = config.getBalancingFeeTuples(chainId);

  // Next, we'll need to compute the first balancing fee from the running balance of the spoke
  // to the running balance of the spoke + the amount
  let balancingFee = computePiecewiseLinearFunction(
    flowCurve,
    runningBalance,
    amount.mul(flowType === "inflow" ? 1 : -1)
  );

  // Apply hardcoded multiplier if incentive fee is a reward instead of a penalty
  if (balancingFee.gt(0)) {
    // This should never error. `getUbaRewardMultiplier` should default to 1
    balancingFee = balancingFee.mul(config.getUbaRewardMultiplier(chainId.toString()));
  }

  // if the chainId is not found in the config
  // If P << uncappedIncentiveFee, discountFactor approaches 100%. Capped at 100%
  if (balancingFee.gt(incentiveBalance)) {
    const discountFactor = min(BigNumber.from(1), balancingFee.sub(incentiveBalance).div(balancingFee));
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
 * @param previousFlows The previous flows of the spoke
 * @param lastValidatedRunningBalance The last validated running balance of the spoke
 * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance of the spoke
 * @param chainId The chain id of the spoke chain
 * @param tokenSymbol The token symbol of the token to calculate the fee for
 * @param config The UBAConfig to use for the calculation
 * @returns The fee for the deposit
 * @see getEventFee
 */
export function getDepositFee(
  amount: BigNumber,
  previousFlows: UbaFlow[],
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  tokenSymbol: string,
  config: UBAConfig
): UBAFlowFee {
  return getEventFee(
    amount,
    "inflow",
    previousFlows,
    lastValidatedRunningBalance,
    lastValidatedIncentiveRunningBalance,
    chainId,
    tokenSymbol,
    config
  );
}

/**
 * Calculates the fee for a refund on a spoke chain
 * @param amount The amount of the refund
 * @param previousFlows The previous flows of the spoke
 * @param lastValidatedRunningBalance The last validated running balance of the spoke
 * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance of the spoke
 * @param chainId The chain id of the spoke chain
 * @param tokenSymbol The token symbol of the token to calculate the fee for
 * @param config The UBAConfig to use for the calculation
 * @returns The fee for the refund
 * @see getEventFee
 */
export function getRefundFee(
  amount: BigNumber,
  previousFlows: UbaFlow[],
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  chainId: number,
  tokenSymbol: string,
  config: UBAConfig
): UBAFlowFee {
  return getEventFee(
    amount,
    "outflow",
    previousFlows,
    lastValidatedRunningBalance,
    lastValidatedIncentiveRunningBalance,
    chainId,
    tokenSymbol,
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
