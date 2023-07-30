import { BigNumber, utils } from "ethers";
import { getEventFee, getDepositFee, getRefundFee } from "./UBAFeeSpokeCalculatorAnalog";
import { toBNWei } from "../utils";
import { MockUBAConfig } from "../clients/mocks";
import { computePiecewiseLinearFunction } from "./UBAFeeUtility";

describe("UBAFeeSpokeCalculatorAnalog", () => {
  describe.only("getEventFee", () => {
    // Create a chain Id that we can reference anywhere
    // without any magic numbers.
    const chainId = "1";

    it("should expect if our balancing fee is positive, that the result is a single integration", () => {
      // We start with a basic config that's been instantiated.
      const config = new MockUBAConfig();
      // We set the balancing fee curve to be a basic curve that has a positive slope.
      // We can work in terms of any decimal as long as we're consistent & the second value
      // in the tuple is in terms of wei or any other 18 decimal token.
      config.setBalancingFeeCurve(chainId, [
        [toBNWei(0, 6), toBNWei(0, 0)],
        [toBNWei(1, 6), toBNWei(0.2, 18)],
      ]);
      // We set the reward multiplier to be 1. This is to ensure that we don't have any
      // additional reward multiplier that would affect our calculations.
      config.setRewardMultiplier(chainId, utils.parseEther("1"));
      // We set the amount, lastRunningBalance, and lastIncentiveBalance for our test.
      // Note: we need to ensure that this matches the fixed decimals of the balancing fee curve.
      const amount = toBNWei(10, 6);
      const lastRunningBalance = toBNWei(1000, 6);
      const lastIncentiveBalance = toBNWei(1000, 6);
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
          toBNWei(0, 6), // We set the amount to be 0
          "inflow",
          lastRunningBalance,
          lastIncentiveBalance,
          Number(chainId),
          config
        ).balancingFee.toString()
      ).toEqual("0");

      // We set the balancing fee curve to be a flat line at 0.
      config.setBalancingFeeCurve(chainId, [[toBNWei(0, 6), toBNWei(0, 0)]]);
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
    });
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
