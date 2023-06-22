import { BigNumber } from "ethers";
import { MAX_SAFE_JS_INT } from "@uma/common/dist/Constants";
import { toBN } from "../utils";
import { HUBPOOL_CHAIN_ID } from "../constants";
import { parseEther } from "ethers/lib/utils";
import { UBAActionType } from "./UBAFeeTypes";

/**
 * Computes a linear integral over a piecewise function
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param index The index of the cutoffArray that we're currently in
 * @param integralStart Where we're starting the integral
 * @param integralEnd Where we're ending the integral
 * @returns The integral of the piecewise function over the given range
 */
export function performLinearIntegration(
  cutoffArray: [BigNumber, BigNumber][],
  index: number,
  integralStart: BigNumber,
  integralEnd: BigNumber,
  precisionDecimals = 18
): BigNumber {
  const scaler = BigNumber.from(10).pow(precisionDecimals);
  const lengthUnderCurve = integralEnd.sub(integralStart);
  const resolveValue = (index: number): BigNumber => cutoffArray[index][1];
  let feeIntegral = resolveValue(
    index === 0 ? 0 : index === cutoffArray.length ? cutoffArray.length - 1 : index - 1
  ).mul(lengthUnderCurve); // (y - x) * fbar[-1]
  // If we're not in the bounds of this array, we need to perform an additional computation
  if (index > 0 && index < cutoffArray.length) {
    const [currCutoff, currValue] = cutoffArray[index];
    const [prevCutoff, prevValue] = cutoffArray[index - 1];
    const slope = prevValue.sub(currValue).mul(scaler).div(prevCutoff.sub(currCutoff));
    // We need to compute a discrete integral at this point. We have the following
    // psuedo code:
    // fee_integral = (
    //     fx_i*(integral_end - integral_start) +
    //     slope*(
    //         (integral_end**2/2 - x_i*integral_end) -
    //         (integral_start**2/2 - x_i*integral_start)
    //     )
    // )
    // NOT: we define the variables above [x_i, fx_i ] as [currCutoff, currValue] in the code below
    const integralEndExpression = integralEnd.pow(2).div(2).sub(prevCutoff.mul(integralEnd));
    const integralStartExpression = integralStart.pow(2).div(2).sub(prevCutoff.mul(integralStart));
    feeIntegral = feeIntegral.add(slope.mul(integralEndExpression.sub(integralStartExpression)));
  }
  return feeIntegral.div(scaler).div(scaler);
}

/**
 * Retrieve the numerical bounds of a given interval from an array of buckets
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param index The index of the cutoffArray that we're currently in
 * @returns The upper and lower bounds of the interval
 */
export function getBounds(cutoffArray: [BigNumber, BigNumber][], index: number): [BigNumber, BigNumber] {
  const largestBound = BigNumber.from(parseUnits((-MAX_SAFE_JS_INT).toString(), 18)).mul(-1);
  if (index === 0) {
    return [largestBound.mul(-1), cutoffArray[0][0]];
  } else if (index < cutoffArray.length) {
    return [cutoffArray[index - 1][0], cutoffArray[index][0]];
  } else {
    return [cutoffArray[cutoffArray.length - 1][0], largestBound];
  }
}

/**
 * Get the interval that the target is within and the bounds of that interval
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param target The target value that we're trying to find the interval for
 * @returns The index of the interval that the target is in and the bounds of that interval
 */
export function getInterval(
  cutoffArray: [BigNumber, BigNumber][],
  target: BigNumber
): [number, [BigNumber, BigNumber]] {
  let result: [number, [BigNumber, BigNumber]] = [
    -1,
    [BigNumber.from(-MAX_SAFE_JS_INT), BigNumber.from(MAX_SAFE_JS_INT)],
  ];
  for (let i = 0; i <= cutoffArray.length; i++) {
    const [lowerBound, upperBound] = getBounds(cutoffArray, i);
    if (target.gte(lowerBound) && target.lt(upperBound)) {
      result = [i, [lowerBound, upperBound]];
      break;
    }
  }
  return result;
}

/**
 * Computes the balancing fee for a refund request
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param runningBalance The current running balance of the spoke pool
 * @param modificationAmount The amount that the user will be refunding
 * @returns The balancing fee for the refund
 */
export function getRefundBalancingFee(
  cutoffArray: [BigNumber, BigNumber][],
  runningBalance: BigNumber,
  modificationAmount: BigNumber
): BigNumber {
  const [balanceIndex, [balanceLowerBound]] = getInterval(cutoffArray, runningBalance);
  const [balanceLessModificationIndex, [, balanceLessModificationUpperBound]] = getInterval(
    cutoffArray,
    runningBalance.sub(modificationAmount)
  );
  let totalFee = toBN(0);
  for (let index = balanceIndex; index >= balanceLessModificationIndex; index--) {
    let integralStart: BigNumber;
    let integralEnd: BigNumber;

    // If everything is in the same interval, we can just compute the integral
    // from balance to balance - modificationAmount
    if (index === balanceIndex && index === balanceLessModificationIndex) {
      integralStart = runningBalance;
      integralEnd = runningBalance.sub(modificationAmount);
    }
    // If not in the same interval, then when we are in the balance
    // interval, start at balance and go to the lb (because balance-modification)
    // is lower
    else if (index === balanceIndex) {
      integralStart = runningBalance;
      integralEnd = balanceLowerBound;
    }
    // If not in the same interval, then when we are in the balance-less-modification
    // interval, start at balance-less-modification and go to the ub (because balance)
    // is higher
    else if (index === balanceLessModificationIndex) {
      integralStart = balanceLessModificationUpperBound;
      integralEnd = runningBalance.sub(modificationAmount);
    }
    // If not in the same interval, then when we are in the middle interval, start at
    // the lb and go to the ub
    else {
      const [lowerBound, upperBound] = getBounds(cutoffArray, index);
      integralStart = lowerBound;
      integralEnd = upperBound;
    }
    totalFee = totalFee.add(performLinearIntegration(cutoffArray, index, integralStart, integralEnd));
  }
  return totalFee;
}

/**
 * Computes the balancing fee for a deposit.
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param runningBalance The current running balance of the spoke pool
 * @param modificationAmount The amount that the user will be depositing
 * @returns The balancing fee for the deposit
 */
export function getDepositBalancingFee(
  cutoffArray: [BigNumber, BigNumber][],
  runningBalance: BigNumber,
  modificationAmount: BigNumber
): BigNumber {
  const [balanceIndex, [, balanceUpperBound]] = getInterval(cutoffArray, runningBalance);
  const [balancePlusModificationIndex, [balancePlusModificationLowerBound]] = getInterval(
    cutoffArray,
    runningBalance.add(modificationAmount)
  );
  let totalFee = toBN(0);

  // If everything is in the same interval, we can just compute the integral
  // from balance to balance + modificationAmount
  for (let index = balanceIndex; index <= balancePlusModificationIndex; index++) {
    let integralStart: BigNumber;
    let integralEnd: BigNumber;
    // If everything is in the same interval, we can just compute the integral
    // from balance to balance + modificationAmount (this is the same as the refund case except in reverse)
    if (index === balanceIndex && index === balancePlusModificationIndex) {
      integralStart = runningBalance;
      integralEnd = runningBalance.add(modificationAmount);
    }
    // If not in the same interval, then when we are in the balance
    // interval, start at balance and go to the ub (because balance+modification)
    // is higher
    else if (index === balanceIndex) {
      integralStart = runningBalance;
      integralEnd = balanceUpperBound;
    }
    // If not in the same interval, then when we are in the balance-plus-modification
    // interval, start at balance-plus-modification and go to the lb
    else if (index === balancePlusModificationIndex) {
      integralStart = balancePlusModificationLowerBound;
      integralEnd = runningBalance.add(modificationAmount);
    }
    // Otherwise, integrate over the entire interval
    else {
      const [lowerBound, upperBound] = getBounds(cutoffArray, index);
      integralStart = lowerBound;
      integralEnd = upperBound;
    }
    totalFee = totalFee.add(performLinearIntegration(cutoffArray, index, integralStart, integralEnd));
  }

  return totalFee;
}

/**
 * Returns the minimum of two BigNumbers
 * @param a The first BigNumber
 * @param b The second BigNumber
 * @returns The minimum of the two BigNumbers
 */
function minBN(a: BigNumber, b: BigNumber): BigNumber {
  return a.lt(b) ? a : b;
}

/**
 * Returns the maximum of two BigNumbers
 * @param a The first BigNumber
 * @param b The second BigNumber
 * @returns The maximum of the two BigNumbers
 */
function maxBN(a: BigNumber, b: BigNumber): BigNumber {
  return a.gt(b) ? a : b;
}

/**
 * Returns the minimum and maximum of two BigNumbers
 * @param a The first BigNumber
 * @param b The second BigNumber
 * @returns The minimum and maximum of the two BigNumbers
 * @remarks This is a convenience function to avoid having to call minBN and maxBN separately
 */
function minMaxBN(a: BigNumber, b: BigNumber): [BigNumber, BigNumber] {
  return [minBN(a, b), maxBN(a, b)];
}

/**
 * Computes a general integral of a linear piecewise function. It is mindful of the sign of the direction
 * of integration.
 * @param functionBounds An array of tuples that define the cutoff points and values of the piecewise function
 * @param x The lower bound of the integral
 * @param y The upper bound of the integral
 * @returns The integral of the piecewise function over the given range
 */
export function computePiecewiseLinearFunction(
  functionBounds: [BigNumber, BigNumber][],
  x: BigNumber,
  y: BigNumber
): BigNumber {
  // Decompose the bounds into the lower and upper bounds
  const xBar = functionBounds.map((_, idx, arr) => getBounds(arr, idx));
  // We'll need to determine the sign of the integration direction to determine the scale
  // This is because we always want to iterate from MIN(x, y) to MAX(x, y). We can get away
  // with manipulating the direction of x and y because we're integrating a linear function
  // and the integral is symmetric about the x-axis
  const scale = x <= y ? 1 : -1;
  // We want to use the traits of linear integration to our advantage. We know that the integral
  // should always iterate in the positive x direction. To implement this we'll need to determine
  // the start and end of the integral as MIN(x, y) and MAX(x, y) respectively.
  const [lb, ub] = minMaxBN(x, y);
  // We can now determine the indices of the bounds that we'll need to integrate over. We don't need
  // to concern ourselves with bounds outside of the needed range because we'd be wasting cycles
  // iterating over them.
  const [lbIdx, ubIdx] = [getInterval(functionBounds, lb)[0], getInterval(functionBounds, ub)[0]];

  // We can store the integral in this variable
  let integral = toBN(0);
  // We can now iterate over the bounds and perform the integration
  for (let idx = lbIdx; idx <= ubIdx; idx++) {
    // We need to be mindful of the fact that we may be integrating over a single interval
    // and that the bounds of that interval may be the same. If this is the case, we need
    // to make sure that we don't perform an integration over a zero interval.
    const _lb = idx == lbIdx ? lb : xBar[idx - 1][0];
    // If we're at the upper bound, we need to make sure that we don't go out of bounds
    const _ub = idx == ubIdx ? ub : xBar[idx][1];
    // If the lower bound is not equal to the upper bound, we can perform the integration
    // Otherwise we implicitely integrate over a zero interval and add nothing to the integral
    if (!_lb.eq(_ub)) {
      // We can now perform the integration by calling the helper function
      integral = integral.add(performLinearIntegration(functionBounds, idx, _lb, _ub));
    }
  }
  // If the integral is zero, we can return zero - we don't need to perform any additional
  // computations
  if (integral.eq(0)) {
    return toBN(0);
  }
  // Otherwise, we can scale the integral to the correct sign and return it with the modifier
  return integral.mul(scale).div(y.sub(x));
}

/**
 * Computes the utilization at a given point in time based on the
 * current balances and equity of the hub and spoke pool targets.
 * @param decimals The number of decimals for the token
 * @param hubBalance The current balance of the hub pool for the token
 * @param hubEquity The current equity of the hub pool for the token
 * @param ethSpokeBalance The current balance of the ETH spoke pool for the token
 * @param targetSpoke The current balance of the target spoke pool for the token - this is a list.
 * @returns The utilization of the hub pool
 */
export function calculateUtilization(
  decimals: number,
  hubBalance: BigNumber,
  hubEquity: BigNumber,
  ethSpokeBalance: BigNumber,
  spokeTargets: { target: BigNumber; spokeChainId: number }[],
  hubPoolChainId = HUBPOOL_CHAIN_ID
) {
  const numerator = hubBalance
    .add(ethSpokeBalance)
    .add(spokeTargets.reduce((a, b) => (b.spokeChainId !== hubPoolChainId ? a.add(b.target) : a), BigNumber.from(0)));
  const denominator = hubEquity;
  const result = numerator.mul(parseEther("1.0")).div(denominator); // We need to multiply by 1e18 to get the correct precision for the result
  return BigNumber.from(10).pow(decimals).sub(result);
}

export function calculateUtilizationBoundaries(
  action: {
    actionType: UBAActionType;
    amount: BigNumber;
    chainId: number;
  },
  decimals: number,
  hubBalance: BigNumber,
  hubEquity: BigNumber,
  ethSpokeBalance: BigNumber,
  spokeTargets: { target: BigNumber; spokeChainId: number }[],
  hubPoolChainId = HUBPOOL_CHAIN_ID
): { utilizationPostTx: BigNumber; utilizationPreTx: BigNumber } {
  let newEthSpokeBalance = ethSpokeBalance;
  if (action.chainId === hubPoolChainId) {
    if (action.actionType === UBAActionType.Deposit) {
      newEthSpokeBalance = newEthSpokeBalance.add(action.amount);
    } else {
      newEthSpokeBalance = newEthSpokeBalance.sub(action.amount);
    }
  }
  return {
    utilizationPreTx: calculateUtilization(decimals, hubBalance, hubEquity, ethSpokeBalance, spokeTargets),
    utilizationPostTx: calculateUtilization(decimals, hubBalance, hubEquity, newEthSpokeBalance, spokeTargets),
  };
}

/**
 * A mapping of the balancing fee functions to the inflow/outflow types. This is used to
 * as a convenience to avoid having to do multiple if/else statements in the UBAFeeCalculator
 */
export const balancingFeeFunctionLookupMapping = {
  inflow: getDepositBalancingFee,
  outflow: getRefundBalancingFee,
};
