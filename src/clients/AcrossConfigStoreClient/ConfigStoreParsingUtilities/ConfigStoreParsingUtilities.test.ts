import { isUBAOnChainConfig } from "./ConfigStoreParsingUtilities";

const validConfigStore: { reason: string; value: unknown }[] = [
  {
    reason: "valid config",
    value: {
      incentivePoolAdjustment: "23",
      ubaRewardMultiplier: "23",
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
        "1-1": {
          threshold_lower: "3",
          threshold_upper: "3",
          target_lower: "3",
          target_upper: "3",
        },
      },
    },
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
  describe("Set of valid outputs that parser expects to return true", () => {
    validConfigStore.forEach(({ value, reason }, index) => {
      test(`${reason} [Test: ${index + 1}]`, () => {
        expect(isUBAOnChainConfig(value)).toBe(true);
      });
    });
  });

  describe("Set of invalid outputs that parser expects to return false", () => {
    invalidConfigStore.forEach(({ value, reason }, index) => {
      test(`${reason} [Test: ${index + 1}]`, () => {
        expect(isUBAOnChainConfig(value)).toBe(false);
      });
    });
  });
});
