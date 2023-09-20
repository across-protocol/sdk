import { BigNumber } from "ethers";
import { fixedPointAdjustment, toBN } from "../utils";
import { FlowTupleParameters } from "./UBAFeeTypes";
import { UBA_BOUNDS_RANGE_MAX, UBA_BOUNDS_RANGE_MIN } from "../constants";

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
  integralEnd: BigNumber
): BigNumber {
  const lengthUnderCurve = integralEnd.sub(integralStart);
  const resolveValue = (index: number): BigNumber => cutoffArray[index][1];
  // We now need to compute the initial area of the integral. This is required
  // for all cases. However, we need to be mindful of the bounds of the array.
  // If we're at the first index, we need to make sure that we don't go out of bounds
  // Therefore, we want to resolve the value at the current index - 1, being mindful
  // that our smallest value is 0, and the largest value is the length of the array - 1.
  let feeIntegral = resolveValue(Math.max(0, Math.min(cutoffArray.length - 1, index - 1)))
    .mul(lengthUnderCurve)
    .div(fixedPointAdjustment); // (y - x) * fbar[-1]
  // If we're not in the bounds of this array, we need to perform an additional computation
  if (index > 0 && index < cutoffArray.length - 1) {
    const [currCutoff, currValue] = cutoffArray[index];
    const [prevCutoff, prevValue] = cutoffArray[index - 1];
    const slope = prevValue.sub(currValue).mul(fixedPointAdjustment).div(prevCutoff.sub(currCutoff));
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
    const slopeIntegration = slope
      .mul(integralEndExpression.sub(integralStartExpression))
      .div(fixedPointAdjustment)
      .div(fixedPointAdjustment);
    feeIntegral = feeIntegral.add(slopeIntegration);
  }
  return feeIntegral;
}

/**
 * Retrieve the numerical bounds of a given interval from an array of buckets
 * @param cutoffArray An array of tuples that define the cutoff points and values of the piecewise function
 * @param index The index of the cutoffArray that we're currently in
 * @returns The upper and lower bounds of the interval
 */
export function getBounds(cutoffArray: [BigNumber, BigNumber][], index: number): [BigNumber, BigNumber] {
  const length = cutoffArray.length;
  if (index === 0) {
    return [UBA_BOUNDS_RANGE_MIN, cutoffArray[0][0]];
  } else if (index < length) {
    return [cutoffArray[index - 1][0], cutoffArray[index][0]];
  } else {
    return [cutoffArray[length - 1][0], UBA_BOUNDS_RANGE_MAX];
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
  let result: [number, [BigNumber, BigNumber]] = [-1, [UBA_BOUNDS_RANGE_MIN, UBA_BOUNDS_RANGE_MAX]];
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
  functionBounds = [...functionBounds, [UBA_BOUNDS_RANGE_MAX, functionBounds[functionBounds.length - 1][1]]];
  // Decompose the bounds into the lower and upper bounds
  const xBar = functionBounds.map((_, idx, arr) => getBounds(arr, idx));
  // We'll need to determine the sign of the integration direction to determine the scale
  // This is because we always want to iterate from MIN(x, y) to MAX(x, y). We can get away
  // with manipulating the direction of x and y because we're integrating a linear function
  // and the integral is symmetric about the x-axis
  const scale = x.lte(y) ? 1 : -1;
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
    const _lb = idx == lbIdx ? lb : xBar[idx][0];
    // If we're at the upper bound, we need to make sure that we don't go out of bounds
    const _ub = idx == ubIdx ? ub : xBar[idx][1];
    // If the lower bound is not equal to the upper bound, we can perform the integration
    // Otherwise we implicitely integrate over a zero interval and add nothing to the integral
    if (!_lb.eq(_ub)) {
      const currentIntegration = performLinearIntegration(functionBounds, idx, _lb, _ub);
      // We can now perform the integration by calling the helper function
      integral = integral.add(currentIntegration);
    }
  }
  // Otherwise, we can scale the integral to the correct sign and return it with the modifier
  return integral.mul(scale);
}

/**
 * A mapping of the balancing fee functions to the inflow/outflow types. This is used to
 * as a convenience to avoid having to do multiple if/else statements in the UBAFeeCalculator
 */
export const balancingFeeFunctionLookupMapping = {
  inflow: getDepositBalancingFee,
  outflow: getRefundBalancingFee,
};

/**
 * Asserts that the fee curve is valid per the UBA specification.
 * @param feeCurve The fee curve whose validity we are asserting
 * @param validateZeroPoint Whether or not to validate that there is a zero point in the fee curve
 * @throws An error if the fee curve is invalid
 * @note This function is only testing for structural validity. It does not test for
 *       the validity of the parameters of the fee curve.
 */
export function assertValidityOfFeeCurve(feeCurve: FlowTupleParameters, validateZeroPoint: boolean): void {
  // Ensure that the fee curve has at least one element
  if (feeCurve.length === 0) {
    throw new Error("Balancing fee curve must have at least one point");
  }
  // Ensure that the fee curve has tuples of length 2
  if (feeCurve.some((tuple) => tuple.length !== 2)) {
    throw new Error("Balancing fee curve must be a list of tuples");
  }
  // Ensure that there is a zero point in the fee curve
  if (validateZeroPoint && !feeCurve.some((tuple) => tuple[1].eq(0))) {
    throw new Error("Balancing fee curve must have a zero point");
  }
  // Ensure that the x values are strictly monotonically increasing
  if (feeCurve.some((tuple, idx, arr) => idx > 0 && tuple[0].lte(arr[idx - 1][0]))) {
    throw new Error("Balancing fee curve must have strictly increasing x values");
  }

  // Ensure that the y values are monotonically increasing
  if (feeCurve.some((tuple, idx, arr) => idx > 0 && tuple[1].lt(arr[idx - 1][1]))) {
    throw new Error("Balancing fee curve must have increasing y values");
  }
}
