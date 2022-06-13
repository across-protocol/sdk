import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, QueryInterface } from "./relayFeeCalculator";
import { gasCost, BigNumberish, toBNWei } from "../utils";

dotenv.config({ path: ".env" });

const testCapitalCostsConfig: { [token: string]: any } = {
  WBTC: {
    lowerBound: "0.0003",
    upperBound: "0.002",
    cutoff: "15",
    decimals: 8,
  },
  DAI: {
    lowerBound: "0.0003",
    upperBound: "0.0015",
    cutoff: "500000",
    decimals: 18,
  },
};

// Example of how to write this query class
class ExampleQueries implements QueryInterface {
  constructor(private defaultGas = "305572") {}
  async getGasCosts(): Promise<BigNumberish> {
    return gasCost(this.defaultGas, "100");
  }
  async getTokenPrice(): Promise<number | string> {
    return 1;
  }
  async getTokenDecimals(): Promise<number> {
    return 18;
  }
}
describe("RelayFeeCalculator", () => {
  let client: RelayFeeCalculator;
  let queries: ExampleQueries;
  beforeAll(() => {
    queries = new ExampleQueries();
  });
  it("relayerFeeDetails", async () => {
    client = new RelayFeeCalculator({ queries });
    const result = await client.relayerFeeDetails(100000000, "usdc");
    assert.ok(result);
  });
  it("capitalFeePercent", async () => {
    // Invalid capital cost configs throws on construction:
    assert.throws(
      () => new RelayFeeCalculator({ queries, capitalCostsConfig: JSON.stringify({ WBTC: { unknownKey: "0.0003" } }) }),
      /does not contain all expected keys/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: JSON.stringify({ WBTC: { unknownKey: "0.0003", ...testCapitalCostsConfig["WBTC"] } }),
        }),
      /contains unexpected keys/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: JSON.stringify({ WBTC: { ...testCapitalCostsConfig["WBTC"], upperBound: "0.01" } }),
        }),
      /upper bound must be </
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: JSON.stringify({
            WBTC: { ...testCapitalCostsConfig["WBTC"], upperBound: "0.001", lowerBound: "0.002" },
          }),
        }),
      /lower bound must be <= upper bound/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: JSON.stringify({ WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 0 } }),
        }),
      /invalid decimals/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: JSON.stringify({ WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 19 } }),
        }),
      /invalid decimals/
    );

    const client = new RelayFeeCalculator({
      queries,
      capitalCostsConfig: JSON.stringify(testCapitalCostsConfig),
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
