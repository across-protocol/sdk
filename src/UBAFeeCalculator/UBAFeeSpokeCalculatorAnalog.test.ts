import { BigNumber, utils } from "ethers";
import { getEventFee, getDepositFee, getRefundFee } from "./UBAFeeSpokeCalculatorAnalog";
import { fixedPointAdjustment, toBNWei } from "../utils";
import { MockUBAConfig } from "../clients/mocks";
import { computePiecewiseLinearFunction } from "./UBAFeeUtility";

describe("UBAFeeSpokeCalculatorAnalog", () => {
  describe("getEventFee", () => {
    // Create a chain Id that we can reference anywhere
    // without any magic numbers.
    const chainId = "1";

    for (const decimalCount of [6, 12, 18]) {
      describe(`Testing Decimals: ${decimalCount}`, () => {
        // This is the base case for this function. We want to ensure that if we have a
        // positive balancing fee result, that the result is equal to the integration of
        // the balancing fee curve without any additional modifiers.
        it("if balancing fee is positive, then the result is a single integration", () => {
          // We should iterate for 1000 iterations to ensure that we have a good sample size
          // for our fuzz testing.
          for (let iteration = 1; iteration <= 1000; iteration++) {
            // We set the amount, lastRunningBalance, and lastIncentiveBalance for our test.
            // Note: We can do this by generating random numbers
            // Note: we need to ensure that this matches the fixed decimals of the balancing fee curve.
            // Note: we need to ensure that the value is never 0 for these tests.
            const amount = toBNWei(Math.floor(100 * Math.random()) + 1, decimalCount);
            const lastRunningBalance = toBNWei(Math.floor(10_000 * Math.random() + 1), decimalCount);
            const lastIncentiveBalance = toBNWei(Math.floor(10_000 * Math.random()) + 1, decimalCount);

            // We can establish a positive slope with a randomized curve.
            const positiveSlope = toBNWei(Math.random().toFixed(18), 18);

            // We start with a basic config that's been instantiated.
            const config = new MockUBAConfig();
            // We set the balancing fee curve to be a basic curve that has a positive slope.
            // We can work in terms of any decimal as long as we're consistent & the second value
            // in the tuple is in terms of wei or any other 18 decimal token.
            config.setBalancingFeeCurve(chainId, [
              [toBNWei(0, decimalCount), toBNWei(0, 0)],
              [toBNWei(1, decimalCount), positiveSlope],
            ]);
            // We set the reward multiplier to be 1. This is to ensure that we don't have any
            // additional reward multiplier that would affect our calculations.
            config.setRewardMultiplier(chainId, utils.parseEther("1"));
            // We call the getEventFee function with the parameters we've set above.
            const fee = getEventFee(amount, "inflow", lastRunningBalance, lastIncentiveBalance, 1, config).balancingFee;
            // We are expecting that the fee will be positive. As a result, let's assert
            // that the fee is greater than 0.
            expect(fee.gt(0)).toBeTruthy();
            // Because the fee is greater than zero, we applied no additional reward multiplier,
            // or any other factors that would affect the fee, we expect that the fee will be
            // equal to the integration of the balancing fee curve.
            const integration = computePiecewiseLinearFunction(
              config.getBalancingFeeTuples(Number(chainId)),
              lastRunningBalance,
              lastRunningBalance.add(amount)
            );
            // We expect that the fee is equal to the integration of the balancing fee curve.
            // Note: we need to ensure that we're using the same decimals as the balancing fee curve.
            // Note: The expectation above is that our fee is positive
            expect(fee.toString()).toEqual(integration.toString());

            // As an edge case, we can also test that if the balancing fee that is initially computed
            // from the integral as zero, that the fee is also zero. This can be done in two ways:
            // 1. We can set the balancingCurve to be a flat line at 0.
            // 2. We can set the amount to be 0.
            // We'll test both of these cases below.

            // We start with zero amount
            expect(
              getEventFee(
                toBNWei(0, decimalCount), // We set the amount to be 0
                "inflow",
                lastRunningBalance,
                lastIncentiveBalance,
                Number(chainId),
                config
              ).balancingFee.toString()
            ).toEqual("0");

            // We set the balancing fee curve to be a flat line at 0.
            config.setBalancingFeeCurve(chainId, [[toBNWei(0, decimalCount), toBNWei(0, 0)]]);
            expect(
              getEventFee(
                amount,
                "inflow",
                lastRunningBalance,
                lastIncentiveBalance,
                Number(chainId),
                config
              ).balancingFee.toString()
            ).toEqual("0");
          }
        });

        // We now want to test the specific code path where the balancing fee is negative initially
        // but the incentive balance is not positive (i.e. 0 or negative). In this case, we expect
        // that the fee will be zero.
        it("should return a balancing fee of 0 if the balancing fee is initially negative and incentive balance is non-positive", () => {
          // We should iterate for 1000 iterations to ensure that we have a good sample size
          // for our fuzz testing.
          for (let iteration = 1; iteration <= 1000; iteration++) {
            // We set the amount and lastRunningBalance for our test.
            // Note: We can do this by generating random numbers
            // Note: we need to ensure that this matches the fixed decimals of the balancing fee curve.
            // Note: we need to ensure that the value is never 0 for these tests.
            const amount = toBNWei(Math.floor(100 * Math.random()) + 1, decimalCount);
            const lastRunningBalance = toBNWei(Math.floor(10_000 * Math.random() + 1), decimalCount);

            // We can establish a positive slope with a randomized curve.
            const positiveSlope = toBNWei(Math.random().toFixed(18), 18);

            // We want to start by setting up a config that has a basic balancing fee curve.
            // The curve itself isn't necessarily important, but we do want to ensure that
            // we have a valid curve that will return an expected negative number when we
            // test for an outflow event.
            const config = new MockUBAConfig();
            config.setBalancingFeeCurve(chainId, [
              [toBNWei(0, decimalCount), toBNWei(0, 0)],
              [toBNWei(1, decimalCount), positiveSlope],
            ]);
            // We set the reward multiplier to be 1. This is to ensure that we don't have any
            // additional reward multiplier that would affect our calculations. Note: this is
            // not required since we won't be reaching that branching factor in our function, but
            // it is good to be explicit.
            config.setRewardMultiplier(chainId, utils.parseEther("1"));

            // We'll set the lastIncentiveBalance to be positive initially. This will ensure that we
            // branch into the negative incentive balance case. We will redefine this value to
            // be zero and negative later in the code.
            let lastIncentiveBalance = toBNWei(Math.floor(Math.random() * 100) + 1, decimalCount);
            // We call the getEventFee function with the parameters we've set above.
            let fee = getEventFee(amount, "outflow", lastRunningBalance, lastIncentiveBalance, 1, config).balancingFee;
            // Since our lastIncentiveBalance is positive, we expect that the fee will be negative.
            expect(fee.lt(0)).toBeTruthy();
            // Now we can set the lastIncentiveBalance to be zero to ensure that calling our fee
            // again will result in a zero
            lastIncentiveBalance = toBNWei(0, decimalCount);
            fee = getEventFee(amount, "outflow", lastRunningBalance, lastIncentiveBalance, 1, config).balancingFee;
            expect(fee.toString()).toEqual("0");
            // Finally, we can set the lastIncentiveBalance to be negative to ensure that calling
            // our fee again will result in a zero
            lastIncentiveBalance = toBNWei(Math.floor(Math.random() * -100) + 1, decimalCount);
            fee = getEventFee(amount, "outflow", lastRunningBalance, lastIncentiveBalance, 1, config).balancingFee;
            expect(fee.toString()).toEqual("0");
          }
        });

        // We now want to test the specific code path where the balancing fee is negative initially
        // and the incentive balance is positive, but the zero fee threshold is not met. In this case,
        // we expect that the fee will simply be discounted by the reward multiplier provided in the
        // config.
        it("should return a balancing fee that is discounted by the reward multiplier if the balancing fee is initially negative and incentive balance is positive but below the zero fee threshold", () => {
          // We want to start by setting up a config that has a basic balancing fee curve.
          // The curve itself isn't necessarily important, but we do want to ensure that
          // we have a valid curve that will return an expected negative number when we
          // test for an outflow event.
          const config = new MockUBAConfig();
          config.setBalancingFeeCurve(chainId, [
            [toBNWei(0, decimalCount), toBNWei(0, 0)],
            [toBNWei(1, decimalCount), toBNWei(0.2, 18)],
          ]);
          // We set the reward multiplier to be 1. This is to ensure that we don't have any
          // additional reward multiplier that would affect our calculations. Note: this is
          // the base case of our test. We will be changing this value later in the test.
          config.setRewardMultiplier(chainId, utils.parseEther("1"));
          // We set the amount, lastRunningBalance, and lastIncentiveBalance for our test.
          const amount = toBNWei(100, decimalCount);
          const lastRunningBalance = toBNWei(10000, decimalCount);
          const lastIncentiveBalance = toBNWei(10000, decimalCount);
          // We call the getEventFee function with the parameters we've set above.
          const baselineFee = getEventFee(
            amount,
            "outflow",
            lastRunningBalance,
            lastIncentiveBalance,
            Number(chainId),
            config
          ).balancingFee;
          // Since our lastIncentiveBalance is positive, we expect that the fee will be negative.
          expect(baselineFee.lt(0)).toBeTruthy();
          // Now that we have our baseline fee that is negative, we can set the reward multiplier
          // to various values to ensure that the fee is discounted by the reward multiplier.
          // Let's create a list of reward multipliers to test. Note: these values are numeric strings
          // that we will convert to BigNumber values.
          // NOTE: we want to test a range of positive, non-zero, and zero values.
          const rewardMultipliers = ["0.5", "0.25", "0.1", "0.01", "0.001", "-1.2", "0"];
          // We'll iterate over these values and ensure that the fee is discounted by the reward multiplier.
          for (const rawRewardMultiplier of rewardMultipliers) {
            // We convert the rawRewardMultiplier to a BigNumber value.
            const rewardMultiplier = utils.parseEther(rawRewardMultiplier);
            // We set the reward multiplier in the config.
            config.setRewardMultiplier(chainId, rewardMultiplier);
            // We call the getEventFee function with the parameters we've set above.
            const fee = getEventFee(
              amount,
              "outflow",
              lastRunningBalance,
              lastIncentiveBalance,
              Number(chainId),
              config
            ).balancingFee;
            // We can now resove what we expect the multiplier to be against the baseline fee.
            // Note: we'll need to offset by the fixedPointAdjustment to ensure that we're
            // comparing the same decimals.
            const expectedFee = baselineFee.mul(rewardMultiplier).div(utils.parseEther("1"));
            // We expect that the fee is equal to the baseline fee multiplied by the reward multiplier.
            expect(fee.toString()).toEqual(expectedFee.toString());
          }
        });

        // Finally, we want to test the specific code path where the balancing fee is negative initially
        // and the incentive balance is positive, and the zero fee threshold is met. In this case,
        // we expect that the fee will be discounted by the amount to bring the fee back to zero.
        // Note: we are going to need to create a contrived UBAConfig to test this case.
        it("should return a balancing fee that is discounted by the amount to bring the fee back to zero if the balancing fee is initially negative and incentive balance is positive and above the zero fee threshold", () => {
          // We should iterate for 1000 iterations to ensure that we have a good sample size
          // for our fuzz testing.
          for (let i = 0; i < 1000; i++) {
            // We want to start by setting up a config that has a basic balancing fee curve.
            // The curve itself is important in this case because we need to create a fee that
            // meets our requirements for this test.
            const config = new MockUBAConfig();
            // We'll set this to a simple step curve
            config.setBalancingFeeCurve(chainId, [
              [toBNWei(0, decimalCount), toBNWei(0, 0)],
              [toBNWei(1, decimalCount), toBNWei(1, 18)],
            ]);
            // We'll also set the multiplier to one to ensure that we don't have any
            // additional reward multiplier that would affect our calculations.
            config.setRewardMultiplier(chainId, utils.parseEther("1"));

            // We set the amount, lastRunningBalance, and lastIncentiveBalance for our test.
            const amount = toBNWei(Math.floor(Math.random() * 100) + 1, decimalCount);
            const lastRunningBalance = toBNWei(Math.floor(Math.random() * 1000) + 1000, decimalCount);
            let lastIncentiveBalance = toBNWei(Math.floor(Math.random() * 1000) + 10000, decimalCount);
            // We call the getEventFee function with the parameters we've set above.
            const baselineFee = getEventFee(
              amount,
              "outflow",
              lastRunningBalance,
              lastIncentiveBalance,
              Number(chainId),
              config
            ).balancingFee;
            // We need to ensure for clarity that our baseline fee is negative.
            expect(baselineFee.lt(0)).toBeTruthy();
            // We can now step down the lastIncentiveBalance to ensure that we meet the zero fee threshold.
            lastIncentiveBalance = toBNWei(Math.floor(Math.random() * 500) + 500, decimalCount);
            // We call the getEventFee function with the parameters we've set above.
            // We now want to ensure that a discount is applied to the fee to bring it back to zero. What
            // this should result in is a fee that is larger than the baseline fee ( less negative ).
            const fee = getEventFee(
              amount,
              "outflow",
              lastRunningBalance,
              lastIncentiveBalance,
              Number(chainId),
              config
            ).balancingFee;
            // We expect that the fee is greater than the baseline fee.
            expect(fee.gt(baselineFee)).toBeTruthy();

            // From the above data, we know that our zeroPoint is 0. So, in order to compute the
            // zeroPointFee, we need to compute the integral of the curve from 0 to the lastRunningBalance.
            // In numerical terms, this is an integral from the range [0, 1000e{decimalCount}].
            // We can compute this discount factor now.
            const zeroPointFee = computePiecewiseLinearFunction(
              config.getBalancingFeeTuples(Number(chainId)),
              BigNumber.from(0),
              lastRunningBalance
            ).abs(); // We need the absolute value as we're looking for magnitude.
            // As a result, we can expect that the multiplier is:
            const multiplier = lastIncentiveBalance.mul(fixedPointAdjustment).div(zeroPointFee);
            // We can now compute the expected fee.
            const expectedFee = baselineFee.mul(multiplier).div(fixedPointAdjustment);
            // We expect that the fee is equal to the expected fee.
            // NOTE: the reason we can expect this even though we change the lastIncentiveBalance is because
            //       the lastIncentive balance only comes into play when our zeroPoint balance threshold
            //       is met. In this case, we're ensuring that the zeroPoint balance threshold is met.
            expect(fee.toString()).toEqual(expectedFee.toString());
          }
        });
      });
    }
  });

  // The following tests are designed around ensuring that our `getEventFee` specific functions (getDepositFee and getRefundFee) are
  // calculating the same fee as the `getEventFee` function. This is to ensure that the `getEventFee` function is working as expected
  // as well as the `getDepositFee` and `getRefundFee` functions.
  // Based on their design, these calculation functions should always return the same fee as the `getEventFee` function.
  for (const [flowName, flowType] of [
    ["getDepositFee", "inflow"],
    ["getRefundFee", "outflow"],
  ]) {
    describe(flowName, () => {
      // Create a default config to use for all tests in this suite. We don't necessarily need to use this config
      // with any specific values, but we do need to use the same config for all tests in this suite. This is because
      // we're specifically comparing that the output of the getRefund/getDeposit functions are the same as the output
      // as a getEventFee function using the similar inputs.
      const defaultConfig = new MockUBAConfig();
      it("should calculate the same fee as its corresponding event fee", () => {
        // Test this function over a range of random values.
        // In all cases, it should be the same as the event fee for an inflow.
        for (let i = 0; i < 50; i++) {
          // Generate random values for the amount parameter
          const amount = BigNumber.from(Math.floor(Math.random() * 100000));
          // Generate a random number between -50_000 and 50_000 for the lastRunningBalance
          const lastRunningBalance = BigNumber.from(Math.floor(Math.random() * 100000) - 100000);
          // Generate a random number between -50_000 and 50_000 for the lastIncentiveBalance
          const lastIncentiveBalance = BigNumber.from(Math.floor(Math.random() * 100000) - 100000);
          // Generate a random chainId
          const chainId = Math.floor(Math.random() * 100000);
          // Calculate the fee using the function under test
          const fee = (flowType == "inflow" ? getDepositFee : getRefundFee)(
            amount,
            lastRunningBalance,
            lastIncentiveBalance,
            chainId,
            defaultConfig
          );
          const eventFee = getEventFee(
            amount,
            flowType === "inflow" ? "inflow" : "outflow",
            lastRunningBalance,
            lastIncentiveBalance,
            chainId,
            defaultConfig
          );
          expect(fee.balancingFee.toString()).toEqual(eventFee.balancingFee.toString());
        }
      });
    });
  }
});
