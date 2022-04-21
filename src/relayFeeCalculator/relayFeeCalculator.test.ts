import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, QueryInterface } from "./relayFeeCalculator";
import { gasCost, BigNumberish } from "../utils";

dotenv.config({ path: ".env" });

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
  beforeAll(() => {
    const queries = new ExampleQueries();
    client = new RelayFeeCalculator({ queries });
  });
  it("relayerFeeDetails", async () => {
    const result = await client.relayerFeeDetails(100000000, "usdc");
    assert.ok(result);
  });
});
