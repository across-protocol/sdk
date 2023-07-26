import { BigNumber } from "ethers";
import UBAConfig from "./UBAFeeConfig";
import { getEventFee, getDepositFee, getRefundFee } from "./UBAFeeSpokeCalculatorAnalog";
import { toBN } from "../utils";
import { parseEther } from "ethers/lib/utils";

describe("UBAFeeSpokeCalculatorAnalog", () => {
  const defaultConfig = new UBAConfig(
    {
      default: toBN(0),
    },
    {
      default: [
        [toBN(0), toBN(0)],
        [toBN(0), parseEther("2")],
      ],
    },
    {
      default: {
        upperBound: {},
        lowerBound: {},
      },
    },
    {
      default: [[toBN(0), parseEther("1")]],
    },
    {},
    {}
  );

  describe("getEventFee", () => {
    it("should calculate the balancing fee for an inflow event", () => {
      const amount = BigNumber.from(10);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(1000);
      const chainId = 1;
      const flowType = "inflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("20");
    });

    it("should calculate the balancing fee for an outflow event", () => {
      const amount = BigNumber.from(10);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(1000);

      const chainId = 1;
      const flowType = "outflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("-10");
    });

    it("should return a balanceFee of 0 if the amount is 0", () => {
      const amount = BigNumber.from(0);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(1000);
      const chainId = 1;
      const flowType = "outflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("0");
    });

    it("should return a balance fee 0 if lastIncentiveBalance is negative", () => {
      const amount = BigNumber.from(10);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(-1000);
      const chainId = 1;
      const flowType = "outflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("0");
    });

    it("should return a balance fee 0 if lastIncentiveBalance is 0", () => {
      const amount = BigNumber.from(10);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(0);
      const chainId = 1;
      const flowType = "outflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("0");
    });

    describe("Should correctly apply a reward multiplier", () => {
      for (const fee of [-23, 0, 23]) {
        const signToZero = fee === 0 ? "==" : fee > 0 ? ">" : "<";
        it(`should return a balance fee a discounted balance fee if the fee is ${signToZero} 0`, () => {
          const amount = BigNumber.from(10);
          const lastRunningBalance = BigNumber.from(1000);
          const lastIncentiveBalance = BigNumber.from(1000);
          const chainId = 1;
          const flowType = "outflow";

          const originalFee = getEventFee(
            amount,
            flowType,
            lastRunningBalance,
            lastIncentiveBalance,
            chainId,
            defaultConfig
          );

          const config = new UBAConfig(
            {
              default: toBN(0),
            },
            {
              default: [
                [toBN(0), toBN(0)],
                [toBN(0), parseEther("2")],
              ],
            },
            {
              default: {
                upperBound: {},
                lowerBound: {},
              },
            },
            {
              default: [[toBN(0), parseEther("1")]],
            },
            {},
            {
              [chainId]: parseEther(String(fee)),
            }
          );

          const modifiedFee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, config);
          expect(modifiedFee.balancingFee.toString()).toEqual(originalFee.balancingFee.mul(fee).toString());
        });
      }
    });

    it("should return a discounted balance fee if the lastIncentiveBalance is positive", () => {
      const amount = BigNumber.from(10);
      const lastRunningBalance = BigNumber.from(1000);
      const lastIncentiveBalance = BigNumber.from(1000);
      const chainId = 1;
      const flowType = "inflow";
      const fee = getEventFee(amount, flowType, lastRunningBalance, lastIncentiveBalance, chainId, defaultConfig);
      expect(fee.balancingFee.toString()).toEqual("20");
    });
  });

  for (const [flowName, flowType] of [
    ["getDepositFee", "inflow"],
    ["getRefundFee", "outflow"],
  ]) {
    describe(flowName, () => {
      it("should calculate the same fee as its corresponding event fee", () => {
        // Test this function over a range of random values.
        // In all cases, it should be the same as the event fee for an inflow.
        for (let i = 0; i < 1000; i++) {
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
