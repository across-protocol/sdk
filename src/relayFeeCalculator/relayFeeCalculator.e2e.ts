import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, ExampleQueries } from "./relayFeeCalculator";
// import { toBNWei, } from "../utils";
import { ethers } from "ethers";

dotenv.config({ path: ".env" });

describe("RelayFeeCalculator", () => {
  let client: RelayFeeCalculator;
  beforeAll(() => {
    const provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    const queries = new ExampleQueries(provider);
    client = new RelayFeeCalculator({ queries });
  });
  it("relayerFeeDetails", async () => {
    const result = await client.relayerFeeDetails(100000000, "usdc");
    console.log(result);
    assert.ok(result);
  });
});
