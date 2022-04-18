import assert from "assert";
import dotenv from "dotenv";
import { RelayFeeCalculator, DefaultQueries } from "./relayFeeCalculator";
// import { toBNWei, } from "../utils";
import { ethers } from "ethers";

dotenv.config({ path: ".env" });

// const kovanWethAddress = ethers.utils.getAddress("0xd0A1E359811322d97991E03f863a0C30C2cF029C");
// const mainnetWethAddress = ethers.utils.getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
const mainnetUsdcAddress = ethers.utils.getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
describe("RelayFeeCalculator", () => {
  let client: RelayFeeCalculator;
  beforeAll(() => {
    const provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    const queries = new DefaultQueries(provider);
    client = new RelayFeeCalculator({ queries });
  });
  it("relayerFeeDetails", async () => {
    const result = await client.relayerFeeDetails(100000000, mainnetUsdcAddress);
    assert.ok(result);
  });
});
