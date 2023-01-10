import dotenv from "dotenv";
import assert from "assert";
import { ethers } from "ethers";
import { Client } from "./acrossConfigStore";
import { Provider } from "@ethersproject/providers";

dotenv.config();
const configStoreAddress = ethers.utils.getAddress("0x3b03509645713718b78951126e0a6de6f10043f5");
const wethAddress = ethers.utils.getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");

describe("AcrossConfigStore", function () {
  let provider: Provider;
  let client: Client;
  beforeAll(async () => {
    provider = ethers.getDefaultProvider(process.env.NODE_URL_1);
    client = new Client(configStoreAddress, provider);
  });
  test("getL1TokenConfig", async function () {
    const result = await client.getL1TokenConfig(wethAddress);
    assert.ok(result.transferThreshold);
  });
  test("getRateModel", async function () {
    // This test works because we know the L1-->L2 route for WETH has a rate model with all properties set to 0 and
    // that this rate model is different than the default rate model for WETH.
    const result = await client.getRateModel(wethAddress, {}, 1, 10);
    const defaultRateModelResult = await client.getRateModel(wethAddress);
    expect(result).toStrictEqual({
      UBar: "0",
      R0: "0",
      R1: "0",
      R2: "0",
    });
    expect(defaultRateModelResult).not.toStrictEqual(result);
    assert.ok(defaultRateModelResult.R0);
    assert.ok(defaultRateModelResult.R1);
    assert.ok(defaultRateModelResult.UBar);
    assert.ok(defaultRateModelResult.R2);
  });
});
