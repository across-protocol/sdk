import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, QueryInterface } from "./relayFeeCalculator";
import { gasCost, BigNumberish, toBNWei, toBN } from "../utils";

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
    return gasCost(this.defaultGas, 1e9); // 1 gwei
  }
  async getTokenPrice(): Promise<number> {
    // Return token price denominated in ETH, assuming ETH is native token.
    return 1 / 1000; // 1 USDC = 1 / $1000 ETH/USD
  }
  getTokenDecimals(): number {
    return 6;
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
      [1000, "305572000000000000000"],
      [5000, "61114400000000000000"],
      // A test with a prime number
      [104729, "2917740071995340354"],
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
    const result = await client.relayerFeeDetails(100e6, "usdc");
    assert.ok(result);

    // overriding token price also succeeds
    const resultWithPrice = await client.relayerFeeDetails(100e6, "usdc", 1.01);
    assert.ok(resultWithPrice);

    // gasFeePercent is lower if token price is higher.
    assert.equal(
      true,
      toBN(resultWithPrice.gasFeePercent).lt((await client.relayerFeeDetails(100e6, "usdc", 1.0)).gasFeePercent)
    );

    // With fee limit defaulted to 0%, the maxGasFeePercent should be 0 and the minDeposit should be infinite.
    assert.equal(resultWithPrice.maxGasFeePercent, "0");
    assert.equal(resultWithPrice.minDeposit, Number.MAX_SAFE_INTEGER.toString());

    // Set fee limit percent to 10%:
    client = new RelayFeeCalculator({ queries, feeLimitPercent: 10 });
    // Compute relay fee details for an $1000 transfer. Capital fee % is 0 so maxGasFeePercent should be equal to fee
    // limit percent.
    const relayerFeeDetails = await client.relayerFeeDetails(1000e6, "usdc");
    assert.equal(relayerFeeDetails.maxGasFeePercent, toBNWei("0.1"));
    assert.equal(relayerFeeDetails.gasFeeTotal, "305572");
    assert.equal(relayerFeeDetails.minDeposit, toBNWei("3.05572", 6).toString()); // 305,572 / 0.1 = 3055720 then divide by 1e6
    assert.equal(relayerFeeDetails.isAmountTooLow, false);
    assert.equal((await client.relayerFeeDetails(10e6, "usdc")).isAmountTooLow, false);
    assert.equal((await client.relayerFeeDetails(1e6, "usdc")).isAmountTooLow, true);
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
