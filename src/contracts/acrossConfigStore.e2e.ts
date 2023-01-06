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
    const result = await client.getRateModel(wethAddress, 1, 10);
    console.log(result);
    assert.ok(result.UBar);
    assert.ok(result.R0);
    assert.ok(result.R1);
    assert.ok(result.R2);
  });
});
