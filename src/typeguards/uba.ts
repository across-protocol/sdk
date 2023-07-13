import { ThresholdType } from "../UBAFeeCalculator/UBAFeeConfig";

/**
 * A type guard to check if a trigger hurdle is defined.
 * @param triggerHurdle The trigger hurdle to check
 * @returns True if the trigger hurdle is defined, false otherwise. A trigger hurdle is defined if it is not undefined and if it its threshold is not zero.
 */
export function isTriggerHurdleDefined(triggerHurdle?: ThresholdType): triggerHurdle is ThresholdType {
  return triggerHurdle !== undefined && !triggerHurdle.threshold.isZero();
}
