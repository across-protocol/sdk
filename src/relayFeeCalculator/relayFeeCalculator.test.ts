import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, QueryInterface } from "./relayFeeCalculator";
import { gasCost, BigNumberish, toBNWei } from "../utils";

dotenv.config({ path: ".env" });

const testCapitalCostsConfig: { [token: string]: any } = {
  WBTC: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.002").toString(),
    cutoff: toBNWei("15").toString(),
    decimals: 8,
  },
  DAI: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.0015").toString(),
    cutoff: toBNWei("500000").toString(),
    decimals: 18,
  },
};

// Example of how to write this query class
class ExampleQueries implements QueryInterface {
  constructor(private defaultGas = "305572") {}
  async getGasCosts(): Promise<BigNumberish> {
    return gasCost(this.defaultGas, "100");
  }
  async getTokenPrice(): Promise<number> {
    return 1;
  }
  getTokenDecimals(): number {
    return 18;
  }
}
describe("RelayFeeCalculator", () => {
  let client: RelayFeeCalculator;
  let queries: ExampleQueries;
  beforeAll(() => {
    queries = new ExampleQueries();
  });
  it("gasPercentageFee", async () => {
    client = new RelayFeeCalculator({ queries });
    // A list of inputs and ground truth [input, ground truth]
    const gasFeePercents = [
      [1000, "30557200000000000000000"],
      [5000, "6111440000000000000000"],
      // A test with a prime number
      [104729, "291774007199534035462"],
    ];
    for (const [input, truth] of gasFeePercents) {
      const result = (await client.gasFeePercent(input, "usdc")).toString();
      expect(result).toEqual(truth);
    }
    // Test that zero amount fails
    await expect(client.gasFeePercent(0, "USDC")).rejects.toThrowError();
  });
  it("relayerFeeDetails", async () => {
    client = new RelayFeeCalculator({ queries });
    const result = await client.relayerFeeDetails(100000000, "usdc");
    assert.ok(result);
  });
  it("capitalFeePercent", async () => {
    // Invalid capital cost configs throws on construction:
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: {
            WBTC: { ...testCapitalCostsConfig["WBTC"], upperBound: toBNWei("0.01").toString() },
          },
        }),
      /upper bound must be </
    );
    assert.throws(
      () =>
        RelayFeeCalculator.validateCapitalCostsConfig({
          ...testCapitalCostsConfig["WBTC"],
          upperBound: toBNWei("0.01").toString(),
        }),
      /upper bound must be </
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: {
            WBTC: {
              ...testCapitalCostsConfig["WBTC"],
              upperBound: toBNWei("0.001").toString(),
              lowerBound: toBNWei("0.002").toString(),
            },
          },
        }),
      /lower bound must be <= upper bound/
    );
    assert.throws(
      () =>
        RelayFeeCalculator.validateCapitalCostsConfig({
          ...testCapitalCostsConfig["WBTC"],
          upperBound: toBNWei("0.001").toString(),
          lowerBound: toBNWei("0.002").toString(),
        }),
      /lower bound must be <= upper bound/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: { WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 0 } },
        }),
      /invalid decimals/
    );
    assert.throws(
      () => RelayFeeCalculator.validateCapitalCostsConfig({ ...testCapitalCostsConfig["WBTC"], decimals: 0 }),
      /invalid decimals/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: { WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 19 } },
        }),
      /invalid decimals/
    );
    assert.throws(
      () => RelayFeeCalculator.validateCapitalCostsConfig({ ...testCapitalCostsConfig["WBTC"], decimals: 19 }),
      /invalid decimals/
    );
    const client = new RelayFeeCalculator({
      queries,
      capitalCostsConfig: testCapitalCostsConfig,
      capitalCostsPercent: 0.01,
    });

    // If token doesn't have a config set, then returns default fixed fee %:
    assert.equal((await client.capitalFeePercent(toBNWei("1"), "UNKNOWN")).toString(), toBNWei("0.0001").toString());

    // Test with different decimals:

    // Amount near zero should charge slightly more than lower bound
    assert.equal((await client.capitalFeePercent(toBNWei("0.001", 8), "WBTC")).toString(), "300056666666000");
    assert.equal((await client.capitalFeePercent(toBNWei("1"), "DAI")).toString(), "300001200000000");
    // Amount right below cutoff should charge slightly below 1/2 of (lower bound + upper bound)
    assert.equal((await client.capitalFeePercent(toBNWei("14.999", 8), "WBTC")).toString(), "1149943333333330");
    assert.equal((await client.capitalFeePercent(toBNWei("499999"), "DAI")).toString(), "899998800000000");
    // Amount >>> than cutoff should charge slightly below upper bound
    assert.equal((await client.capitalFeePercent(toBNWei("600", 8), "WBTC")).toString(), "1978749999999999");
    assert.equal((await client.capitalFeePercent(toBNWei("20000000"), "DAI")).toString(), "1485000000000000");
  });
});
