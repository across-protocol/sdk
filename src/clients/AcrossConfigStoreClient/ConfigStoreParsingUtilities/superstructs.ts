import { array, object, record, string, refine, union, optional } from "superstruct";

/**
 * This is a superstruct that verifies that the routing rule is formatted correctly.
 * Specifically, it verifies that the routing rule is either "default" or a string
 * formatted as "{chainId}-{chainId}" where {chainId} is a number.
 */
const CorrectRoutingRule = refine(
  string(),
  "CorrectRoutingRule",
  (value) =>
    // Verifies the key against a regex. The regex is verifying that a route is
    // formatted as follows:  "{chainId}-{chainId}" where {chainId} is
    // a number.
    /^\d+[-]\d+$/.test(value) || value === "default"
);

/**
 * This is a superstruct that verifies that the numeric string is formatted correctly.
 */
const NumericStringRule = refine(string(), "NumericStringRule", (value) => /^\d+$/.test(value) || value === "default");

/**
 * This is a superstruct that verifies that the numeric tuple is formatted correctly.
 * Specifically, it verifies that the numeric tuple is an array of length 2 where
 * each element is a numeric string.
 */
const NumericTupleRule = refine(array(NumericStringRule), "NumericTupleRule", (value) => value.length === 2);

/**
 * This is a superstruct that verifies that a UBA Config is formatted correctly.
 * Specifically, it verifies that the UBA Config is an object with the following
 * keys:
 * - incentivePoolAdjustment: a record of numeric strings to numeric strings
 * - ubaRewardMultiplier: a record of numeric strings to numeric strings
 * - alpha: a record of routing rules to numeric strings
 * - gamma: a record of routing rules to numeric tuples
 * - omega: a record of routing rules to numeric tuples
 * - rebalance: a record of routing rules to objects with the following keys:
 *   - threshold_lower: a numeric string
 *   - threshold_upper: a numeric string
 *   - target_lower: a numeric string
 *   - target_upper: a numeric string
 */
export const UBA_CONFIG_ONCHAIN_SCHEMA = object({
  incentivePoolAdjustment: optional(record(NumericStringRule, NumericStringRule)),
  ubaRewardMultiplier: optional(record(NumericStringRule, NumericStringRule)),
  alpha: union([
    object({
      default: NumericStringRule,
    }),
    record(CorrectRoutingRule, NumericStringRule),
  ]),
  gamma: record(NumericStringRule, array(NumericTupleRule)),
  omega: record(NumericStringRule, array(NumericTupleRule)),
  rebalance: union([
    object({
      default: object({
        threshold_lower: optional(NumericStringRule),
        threshold_upper: optional(NumericStringRule),
        target_lower: optional(NumericStringRule),
        target_upper: optional(NumericStringRule),
      }),
    }),
    record(
      NumericStringRule,
      object({
        threshold_lower: optional(NumericStringRule),
        threshold_upper: optional(NumericStringRule),
        target_lower: optional(NumericStringRule),
        target_upper: optional(NumericStringRule),
      })
    ),
  ]),
});
