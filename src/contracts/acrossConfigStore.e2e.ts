import dotenv from "dotenv";
import assert from "assert";
import { ethers } from "ethers";
import { Client } from "./acrossConfigStore";
import { Provider } from "@ethersproject/providers";

dotenv.config();
// kovan only
const configStoreAddress = ethers.utils.getAddress("0xDd74f7603e3fDA6435aEc91F8960a6b8b40415f3");
const wethAddress = ethers.utils.getAddress("0xd0A1E359811322d97991E03f863a0C30C2cF029C");

describe("AcrossConfigStore", function () {
  let provider: Provider;
  let client: Client;
  beforeAll(async () => {
    provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    client = new Client(configStoreAddress, provider);
  });
  test("getL1TokenConfig", async function () {
    const result = await client.getL1TokenConfig(wethAddress);
    assert.ok(result.transferThreshold);
  });
  test("getRateModel", async function () {
    const result = await client.getRateModel(wethAddress);
    assert.ok(result.UBar);
    assert.ok(result.R0);
    assert.ok(result.R1);
    assert.ok(result.R2);
  });
});
