// The tests below validate the behavior of the LP fee equations. We do not re-implement the equations here as
// this would not actually test anything. Rather, the equations are documented and outputs from a jupyter are
// compared with as a point of reference. Moreover, we only need to validate the final calculateRealizedLpFeePct
// and can skip the underlying methods as if they contain errors so will the calculateRealizedLpFeePct method.
// The python implementation can be seen here: https://gist.github.com/chrismaree/a713725e4fe96c531c42ed7b629d4a85

import assert from "assert";
// Function to test
import { calculateApyFromUtilization, calculateRealizedLpFeePct } from "../src/lpFeeCalculator";
import { toBNWei } from "../src/utils";

// sample interest rate model. note these tests are in JS and so we can impose the RateModel type.
const rateModel = { UBar: toBNWei("0.65"), R0: toBNWei("0.00"), R1: toBNWei("0.08"), R2: toBNWei("1.00") };

describe("Realized liquidity provision calculation", function () {
  it("Realized liquidity provision calculation", function () {
    // Define a set of intervals to test over. Each interval contains the utilization at pointA (before deposit), the
    // utilization at pointB (after the deposit), expected APY rate and the expected weekly rate. The numbers are
    // generated from the juypter notebook defined in the comments above.
    const testedIntervals = [
      { utilA: toBNWei("0"), utilB: toBNWei("0.01"), apy: "615384615384600", wpy: "11830749673498" },
      { utilA: toBNWei("0"), utilB: toBNWei("0.50"), apy: "30769230769230768", wpy: "582965040710805" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.51"), apy: "62153846153846200", wpy: "1160264449662626" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.56"), apy: "65230769230769233", wpy: "1215959072035989" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.5").add(100), apy: "60000000000000000", wpy: "1121183982821340" },
      { utilA: toBNWei("0.6"), utilB: toBNWei("0.7"), apy: "114175824175824180", wpy: "2081296752280018" },
      { utilA: toBNWei("0.7"), utilB: toBNWei("0.75"), apy: "294285714285714280", wpy: "4973074331615530" },
      { utilA: toBNWei("0.7"), utilB: toBNWei("0.7").add(100), apy: "220000000000000000", wpy: "3831376003126766" },
      { utilA: toBNWei("0.95"), utilB: toBNWei("1.00"), apy: "1008571428571428580", wpy: "13502339199904125" },
      { utilA: toBNWei("0"), utilB: toBNWei("0.99"), apy: "220548340548340547", wpy: "3840050658887291" },
      { utilA: toBNWei("0"), utilB: toBNWei("1.00"), apy: "229000000000000000", wpy: "3973273191633388" },
      {
        utilA: toBNWei("0"),
        utilB: toBNWei("100000000000000000000.00"), // Absurdly high utilization to ensure that the wpy caps at 100% or 1e18
        apy: "142857142857142857141079999999999999999",
        wpy: "1000000000000000000",
      },
    ];
    const testedIntervalsTruncated = [
      { utilA: toBNWei("0"), utilB: toBNWei("0.01"), apy: "615384615384600", wpy: "11000000000000" },
      { utilA: toBNWei("0"), utilB: toBNWei("0.50"), apy: "30769230769230768", wpy: "582000000000000" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.51"), apy: "62153846153846200", wpy: "1160000000000000" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.56"), apy: "65230769230769233", wpy: "1215000000000000" },
      { utilA: toBNWei("0.5"), utilB: toBNWei("0.5").add(100), apy: "60000000000000000", wpy: "1121000000000000" },
      { utilA: toBNWei("0.6"), utilB: toBNWei("0.7"), apy: "114175824175824180", wpy: "2081000000000000" },
      { utilA: toBNWei("0.7"), utilB: toBNWei("0.75"), apy: "294285714285714280", wpy: "4973000000000000" },
      { utilA: toBNWei("0.7"), utilB: toBNWei("0.7").add(100), apy: "220000000000000000", wpy: "3831000000000000" },
      { utilA: toBNWei("0.95"), utilB: toBNWei("1.00"), apy: "1008571428571428580", wpy: "13502000000000000" },
      { utilA: toBNWei("0"), utilB: toBNWei("0.99"), apy: "220548340548340547", wpy: "3840000000000000" },
      { utilA: toBNWei("0"), utilB: toBNWei("1.00"), apy: "229000000000000000", wpy: "3973000000000000" },
      {
        utilA: toBNWei("0"),
        utilB: toBNWei("100000000000000000000.00"), // Absurdly high utilization to ensure that the wpy caps at 100% or 1e18
        apy: "142857142857142857141079999999999999999",
        wpy: "1000000000000000000",
      },
    ];

    // Test special rate model case where dividing by 0 can occur
    const zeroRateModel = { UBar: toBNWei(0), R0: toBNWei(0), R1: toBNWei(0), R2: toBNWei(0) };

    testedIntervals.forEach((interval) => {
      const apyFeePct = calculateApyFromUtilization(rateModel, interval.utilA, interval.utilB);
      assert.equal(apyFeePct.toString(), interval.apy);

      const realizedLpFeePct = calculateRealizedLpFeePct(rateModel, interval.utilA, interval.utilB).toString();
      assert.equal(realizedLpFeePct.toString(), interval.wpy);

      assert.ok(calculateApyFromUtilization(zeroRateModel, interval.utilA, interval.utilB));
      assert.equal(calculateApyFromUtilization(zeroRateModel, interval.utilA, interval.utilB).toString(), "0");
      assert.ok(calculateRealizedLpFeePct(zeroRateModel, interval.utilA, interval.utilB));
      assert.equal(calculateRealizedLpFeePct(zeroRateModel, interval.utilA, interval.utilB).toString(), "0");
    });
    testedIntervalsTruncated.forEach((interval) => {
      const apyFeePct = calculateApyFromUtilization(rateModel, interval.utilA, interval.utilB);
      assert.equal(apyFeePct.toString(), interval.apy);

      const realizedLpFeePct = calculateRealizedLpFeePct(rateModel, interval.utilA, interval.utilB, true).toString();
      assert.equal(realizedLpFeePct.toString(), interval.wpy);
    });
  });
});
