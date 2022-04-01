import dotenv from "dotenv";
import { Client, Provider, PoolEventState } from "./poolClient";
import { ethers } from "ethers";
import { TransactionReceipt } from "@ethersproject/abstract-provider";
import assert from "assert";
import set from "lodash/set";
import get from "lodash/get";
import { hubPool } from "./contracts";

dotenv.config();

// kovan only
const hubPoolAddress = ethers.utils.getAddress("0xD449Af45a032Df413b497A709EeD3E8C112EbcE3");
const rateModelStoreAddress = ethers.utils.getAddress("0x5923929DF7A2D6E038bb005B167c1E8a86cd13C8");
const wethAddress = ethers.utils.getAddress("0xd0A1E359811322d97991E03f863a0C30C2cF029C");
const daiAddress = ethers.utils.getAddress("0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa");
const users = [ethers.utils.getAddress("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D")];
const l1Tokens = [daiAddress, wethAddress];
const txReceiptHash = "0xb1cad90827baba0d4db5e510fabf12e1bb296f3ab16112d79b8b6af654949d0f";
const startBlock = 30475928;
const endBlock = 30477298;

describe("PoolEventState", function() {
  let provider: Provider;
  let client: PoolEventState;
  let receipt: TransactionReceipt;
  beforeAll(async () => {
    provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    const instance = hubPool.connect(hubPoolAddress, provider);
    client = new PoolEventState(instance, startBlock);
    receipt = await provider.getTransactionReceipt(txReceiptHash);
  });
  test("read events", async function() {
    const result = await client.read(endBlock);
    const nodupe = await client.read(endBlock);
    assert.deepEqual(result, nodupe);
  });
  test("readTxReceipt", async function() {
    const result = client.readTxReceipt(receipt);
    const nodupe = client.readTxReceipt(receipt);
    assert.deepEqual(result, nodupe);
  });
  test("getL1TokenFromReceipt", async function() {
    const token = client.getL1TokenFromReceipt(receipt);
    assert.equal(token, "0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa");
  });
});
describe("Client", function() {
  const state = {};
  let provider: Provider;
  let client: Client;
  beforeAll(async () => {
    provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    client = new Client({ hubPoolAddress, rateModelStoreAddress, wethAddress }, { provider }, (path, data) =>
      set(state, path, data)
    );
  });
  test("read users", async function() {
    jest.setTimeout(30000);
    for (const userAddress of users) {
      for (const l1Token of l1Tokens) {
        await client.updateUser(userAddress, l1Token);
        const user = get(state, ["users", userAddress, l1Token]);
        const pool = get(state, ["pools", l1Token]);
        assert.ok(pool);
        assert.ok(user);
      }
    }
  });
});
