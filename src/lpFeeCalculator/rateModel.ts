interface RateModel {
  UBar: string; // denote the utilization kink along the rate model where the slope of the interest rate model changes.
  R0: string; // is the interest rate charged at 0 utilization
  R1: string; // R_0+R_1 is the interest rate charged at UBar
  R2: string; // R_0+R_1+R_2 is the interest rate charged at 100% utilization
}

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
