import { parseJSONWithNumericString } from "../../../utils/JSONUtils";
import { isUBAOnChainConfig } from "./ConfigStoreParsingUtilities";

const validConfigStore: { reason: string; value: unknown }[] = [
  {
    reason: "realistic config",
    value: (
      parseJSONWithNumericString(
        '{"rateModel":{"UBar":"750000000000000000","R0":"21000000000000000","R1":"0","R2":"600000000000000000"},"routeRateModel":{"1-10":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-137":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-288":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-42161":{"UBar":"0","R0":"0","R1":"0","R2":"0"}},"spokeTargetBalances":{"10":{"threshold":"500000000000000000000","target":"350000000000000000000"},"137":{"target":"0","threshold":"10000000000000000000"},"42161":{"threshold":"600000000000000000000","target":"400000000000000000000"}},"uba":{"incentivePoolAdjustment": {}, "ubaRewardMultiplier": {}, "alpha":{"default":200000000000000,"1-10":0,"1-137":0,"1-42161":0},"gamma":{"default":[[500000000000000000,0],[650000000000000000,500000000000000],[750000000000000000,1000000000000000],[850000000000000000,2500000000000000],[900000000000000000,5000000000000000],[950000000000000000,50000000000000000]]},"omega":{"10":[[0,0]],"137":[[0,0]],"42161":[[0,0]],"default":[[0,0]]},"rebalance":{"10":{"threshold_lower":0,"target_lower":0,"threshold_upper":500000000000000000000,"target_upper":350000000000000000000},"137":{"threshold_lower":0,"target_lower":0,"threshold_upper":25000000000000000000,"target_upper":15000000000000000000},"42161":{"threshold_lower":0,"target_lower":0,"threshold_upper":600000000000000000000,"target_upper":400000000000000000000},"default":{"threshold_lower":0,"target_lower":0,"threshold_upper":0,"target_upper":0}}}}'
      ) as Record<string, unknown>
    )["uba"],
  },
];
const invalidConfigStore: { reason: string; value: unknown }[] = [
  { reason: "Empty object", value: {} },
  { reason: "Undefined", value: undefined },
  { reason: "Null object", value: null },
  { reason: "Primitive number", value: 1 },
  { reason: "Primitive string", value: "string" },
  { reason: "Empty array", value: [] },
  { reason: "Array with single invalid config", value: [{}] },
  { reason: "Array with single undefined config", value: [undefined] },
  { reason: "Array with single nullified config", value: [null] },
  { reason: "Array with single primitive number", value: [0] },
  { reason: "Array with single string ", value: ["string"] },
  {
    reason: "Invalid config with rebalance not having a default",
    value: {
      alpha: {
        default: "23",
      },
      omega: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      gamma: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      rebalance: {
        defaulting: {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
  },
  {
    reason: "Invalid config with rebalance having a key that isn't '{number}-{number}'",
    value: {
      alpha: {
        default: "23",
      },
      omega: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      gamma: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      rebalance: {
        default: {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
        "1-": {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
  },
  {
    reason: "Invalid config with rebalance having a key that isn't '{number}-{number}'",
    value: {
      alpha: {
        default: "23",
      },
      omega: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      gamma: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      rebalance: {
        default: {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
        "-1": {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
  },
  {
    reason: "Invalid config with rebalance having a key that isn't '{number}-{number}'",
    value: {
      alpha: {
        default: "23",
      },
      omega: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      gamma: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      rebalance: {
        default: {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
        "1": {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
  },
  {
    reason: "Invalid config with rebalance having a non-numeric value",
    value: {
      alpha: {
        default: "23",
      },
      omega: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      gamma: {
        default: {
          cutoff: [],
          value: [],
        },
      },
      rebalance: {
        default: {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
        "1": {
          threshold_lower: "3.2",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
  },
];
describe("Test that we can effectively parse the UBA Config", () => {
  (
    [
      [validConfigStore, true],
      [invalidConfigStore, false],
    ] as [
      {
        reason: string;
        value: unknown;
      }[],
      boolean,
    ][]
  ).forEach(([store, expected]) => {
    describe(`Test that we can effectively parse the UBA Config with ${expected ? "valid" : "invalid"} inputs`, () => {
      store.forEach(({ value, reason }, index) => {
        test(`${reason} [Test: ${index + 1}]`, () => {
          expect(isUBAOnChainConfig(value)).toBe(expected);
        });
      });
    });
  });
});
