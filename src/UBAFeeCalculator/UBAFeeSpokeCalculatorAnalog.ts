/** Provides the static, procedural versions of the functions provided in the UBAFeeSpokeCalculator */

import { BigNumber, ethers } from "ethers";
import { UbaFlow, isUbaInflow } from "../interfaces";
import { TokenRunningBalanceWithNetSend, UBAActionType, UBAFlowFee } from "./UBAFeeTypes";
import UBAConfig from "./UBAFeeConfig";
import { fixedPointAdjustment, max, toBN } from "../utils";
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
  flows: (UbaFlow & { incentiveFee: BigNumber })[],
  lastValidatedRunningBalance: BigNumber,
  lastValidatedIncentiveRunningBalance: BigNumber,
  lastNetRunningBalanceAdjustment: BigNumber,
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
      // Now, add this flow's amount to the accumulated running balance.
      // If the flow is an inflow, we need to add the amount to the running balance
      // If the flow is an outflow, we need to subtract the amount from the running balance
      // Incentive balances for each flow can be negative or positive so simply add them to the accumulatedd
      // incentive balance.
      // @dev Positive incentive fees are added to the incentive pot. Negative incentive fees are rewards
      // paid out of the pot. The incentive pot should never go negative.
      const incentiveFee = flow.incentiveFee;
      if (incentiveFee.mul(-1).gt(acc.incentiveBalance)) {
        throw new Error(
          `Incentive balance will go negative after subtracting flow's incentive reward of ${incentiveFee.toString()} from incentive balance of ${acc.incentiveBalance.toString()}`
        );
      }
      const resultant: TokenRunningBalanceWithNetSend = {
        netRunningBalanceAdjustment: toBN(acc.netRunningBalanceAdjustment.toString()), // Deep copy via string conversion
        runningBalance: acc.runningBalance[isUbaInflow(flow) ? "add" : "sub"](flow.amount).sub(incentiveFee),
        incentiveBalance: max(ethers.constants.Zero, acc.incentiveBalance.add(incentiveFee)),
      };
      // console.log(
      //   `- Added ${incentiveFee.toString()} to existing incentive pot ${acc.incentiveBalance.toString()}, new incentive pot = ${resultant.incentiveBalance.toString()}`
      // );

      const { target: upperBoundTarget, threshold: upperBoundThreshold } = upperBoundTriggerHurdle;
      const { target: lowerBoundTarget, threshold: lowerBoundThreshold } = lowerBoundTriggerHurdle;

      // If the upper trigger hurdle is surpassed, we need to return the trigger hurdle value
      // as the running balance. This is because the trigger hurdle is the maximum value we'd like to
      // organically grow the running balance to. If the running balance exceeds the trigger hurdle,
      // we need to return the trigger hurdle as the running balance because at this point the dataworker
      // will be triggered to rebalance the running balance.

      if (
        upperBoundTarget !== undefined &&
        upperBoundThreshold !== undefined &&
        upperBoundThreshold.gt(0) &&
        resultant.runningBalance.gt(upperBoundThreshold)
      ) {
        // If we are over the target, subtract the difference from the net running balance adjustment
        // so that the dataworker can instruct the spoke pool to return funds to the hub pool.
        resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.sub(
          resultant.runningBalance.sub(upperBoundTarget)
        );
        // Set the running balance to the trigger hurdle
        resultant.runningBalance = upperBoundTarget;
      }

      // If the lower trigger hurdle is surpassed, we need to return the trigger hurdle value
      // as the running balance. This is because the trigger hurdle is the minimum value we'd like to
      // organically shrink the running balance to. If the running balance is less than the trigger hurdle,
      // we need to return the trigger hurdle as the running balance because at this point the dataworker
      // will be triggered to rebalance the running balance.
      else if (
        lowerBoundTarget !== undefined &&
        lowerBoundThreshold !== undefined &&
        lowerBoundThreshold.gt(0) &&
        resultant.runningBalance.lt(lowerBoundThreshold)
      ) {
        // If we are under the target, add the difference to the net running balance adjustment
        // so that the dataworker can instruct the hub pool to send funds to the spokepool.
        resultant.netRunningBalanceAdjustment = resultant.netRunningBalanceAdjustment.add(
          lowerBoundTarget.sub(resultant.runningBalance)
        );
        // Set the running balance to the trigger hurdle
        resultant.runningBalance = lowerBoundTarget;
      }

      return resultant;
    },
    {
      runningBalance: lastValidatedRunningBalance ?? toBN(0),
      incentiveBalance: lastValidatedIncentiveRunningBalance ?? toBN(0),
      netRunningBalanceAdjustment: lastNetRunningBalanceAdjustment ?? toBN(0),
    }
  );
  // Return the result
  return historicalResult;
}

/**
 * Returns the balancing fee for a given event that produces a flow of `flowType` of size `amount`.
 * Can return a negative fee if the fee is a reward.
 * @param amount Amount of inflow or outflow produced by event that we're computing a balancing fee for.
 * @param flowType Inflow or Outflow.
 * @param lastRunningBalance The latest running balance preceding this event.
 * @param lastIncentiveBalance The latest incentive balance preceding this event.
 * @param chainId The chain id of the spoke chain
 * @param config The UBAConfig to use for the calculation
 * @returns The incentive fee to charge, NOT a percentage.
 */
export function getEventFee(
  amount: BigNumber,
  flowType: "inflow" | "outflow",
  lastRunningBalance: BigNumber,
  lastIncentiveBalance: BigNumber,
  chainId: number,
  config: UBAConfig
): UBAFlowFee {
  // We first need to resolve the inflow/outflow curves for the flow chain
  const flowCurve = config.getBalancingFeeTuples(chainId);

  // Next, we'll need to compute the balancing fee by integrating the flow curve from the running balance to
  // the running balance post-flow.
  let balancingFee = computePiecewiseLinearFunction(
    flowCurve,
    lastRunningBalance,
    lastRunningBalance.add(amount.mul(flowType === "inflow" ? 1 : -1))
  );

  // If the balancing fee is a reward paid to the user or relayer then we might need to discount it based on
  // availbale rewards. Negative balancing fees are rewards.
  if (balancingFee.lt(0)) {
    // If incentive balance is <= 0 then return early because the balancing reward must be 0 as there are
    // no incentives to pay with.
    if (lastIncentiveBalance.lte(0)) {
      // console.log("- Last incentive balance is 0, balancing fee must be 0");
      return {
        balancingFee: ethers.constants.Zero,
      };
    }

    // First, apply hardcoded multiplier if incentive fee is a reward instead of a penalty
    // This should never error. `getUbaRewardMultiplier` should default to 1 and be in 18 decimal precision
    const ubaRewardMultiplier = config.getUbaRewardMultiplier(chainId.toString());
    balancingFee = balancingFee.mul(ubaRewardMultiplier).div(fixedPointAdjustment);

    // Next, compute the amount of fees that would be required to be paid out of the incentive balance
    // to bring the the marginal balance fee to 0. This is found by finding the point on the flow curve
    // where the fee is 0 and integrating from there to the last running balance without including
    // the current action. In other words, this is the total amount of incentive fees that must be reserved
    // in the incentive balance at a minimum to "incentivize" depositors/relayers to bring the running
    // balance to its target.
    const zeroFeePoint = config.getZeroFeePointOnBalancingFeeCurve(chainId);
    const feesToBringFeePctToZero = computePiecewiseLinearFunction(flowCurve, zeroFeePoint, lastRunningBalance).abs();
    // console.log(`- feesToBringFeePctToZero = ${feesToBringFeePctToZero.toString()}`);

    // The discount factor to apply is equal to the balance fee to bring the fee % back to 0 divided
    // by the incentive balance, capped at 100%.
    // @dev balancing fee, amount, and last incentive balance should all be in the same decimals precision.
    if (feesToBringFeePctToZero.gt(lastIncentiveBalance)) {
      // console.log(
      //   `- discounting balancing reward because feesToBringFeePctToZero exceeds incentive balance. Starting balancing fee = ${balancingFee.toString()}, incentive balance = ${lastIncentiveBalance.toString()}`
      // );

      // Discount factor should be in 18 decimal precision and should always be <= 1 since
      // feesToBringFeePctToZero > lastIncentiveBalance
      const discountFactor = lastIncentiveBalance.mul(fixedPointAdjustment).div(feesToBringFeePctToZero);
      balancingFee = balancingFee.mul(discountFactor).div(fixedPointAdjustment);
      // console.log(`- Discount factor = ${discountFactor}%, resultant balancing fee = ${balancingFee}`);
    }
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
