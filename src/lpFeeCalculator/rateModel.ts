import { RateModel } from "../lpFeeCalculator";

const expectedRateModelKeys = ["UBar", "R0", "R1", "R2"];

/**
 * Helper method that returns parsed rate model from string, or throws.
 * @param rateModelString Stringified rate model to parse.
 * @returns Rate model object. Must conform to `expectedRateModelKeys` format.
 */
export const parseAndReturnRateModelFromString = (rateModelString: string): RateModel => {
  const rateModelFromEvent = JSON.parse(rateModelString);

  // Rate model must contain the exact same keys in `expectedRateModelKeys`.
  for (const key of expectedRateModelKeys) {
    if (!Object.keys(rateModelFromEvent).includes(key)) {
      throw new Error(
        `Rate model does not contain all expected keys. Expected keys: [${expectedRateModelKeys}], actual keys: [${Object.keys(
          rateModelFromEvent
        )}]`
      );
    }
  }

  for (const key of Object.keys(rateModelFromEvent)) {
    if (!expectedRateModelKeys.includes(key)) {
      throw new Error(
        `Rate model contains unexpected keys. Expected keys: [${expectedRateModelKeys}], actual keys: [${Object.keys(
          rateModelFromEvent
        )}]`
      );
    }
  }

  return {
    UBar: rateModelFromEvent.UBar,
    R0: rateModelFromEvent.R0,
    R1: rateModelFromEvent.R1,
    R2: rateModelFromEvent.R2,
  };
};
