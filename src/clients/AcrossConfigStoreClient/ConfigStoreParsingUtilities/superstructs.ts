import { array, object, record, string, intersection, refine } from "superstruct";

const CorrectRoutingRule = refine(string(), "CorrectRoutingRule", (value) =>
  // Verifies the key against a regex. The regex is verifying that a route is
  // formatted as follows: "{chainId}" or "{chainId}-{chainId}" where {chainId} is
  // a number.
  /^\d+(-\d+)?$/.test(value)
);

export const UBA_CONFIG_ONCHAIN_SCHEMA = object({
  alpha: intersection([
    object({
      default: string(),
    }),
    record(CorrectRoutingRule, string()),
  ]),
  gamma: intersection([
    object({
      default: object({
        cutoff: array(string()),
        value: array(string()),
      }),
    }),
    record(
      CorrectRoutingRule,
      object({
        cutoff: array(string()),
        value: array(string()),
      })
    ),
  ]),
  omega: intersection([
    object({
      default: object({
        cutoff: array(string()),
        value: array(string()),
      }),
    }),
    record(
      CorrectRoutingRule,
      object({
        cutoff: array(string()),
        value: array(string()),
      })
    ),
  ]),
  rebalance: intersection([
    object({
      default: object({
        threshold_lower: string(),
        threshold_upper: string(),
        target_lower: string(),
        target_upper: string(),
      }),
    }),
    record(
      CorrectRoutingRule,
      object({
        threshold_lower: string(),
        threshold_upper: string(),
        target_lower: string(),
        target_upper: string(),
      })
    ),
  ]),
});
