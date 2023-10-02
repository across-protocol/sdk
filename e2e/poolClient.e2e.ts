import dotenv from "dotenv";
import { Client, Provider, PoolEventState } from "../src/pool";
import { ethers } from "ethers";
import assert from "assert";
import set from "lodash/set";
import get from "lodash/get";
import { hubPool } from "../src/contracts";

dotenv.config();

// goerli only
const hubPoolAddress = ethers.utils.getAddress("0x0e2817C49698cc0874204AeDf7c72Be2Bb7fCD5d");
const configStoreAddress = ethers.utils.getAddress("0xDd74f7603e3fDA6435aEc91F8960a6b8b40415f3");
const wethAddress = ethers.utils.getAddress("0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6");
const daiAddress = ethers.utils.getAddress("0x5C221E77624690fff6dd741493D735a17716c26B");
const acceleratingDistributorAddress = ethers.utils.getAddress("0xA59CE9FDFf8a0915926C2AF021d54E58f9B207CC");
const merkleDistributorAddress = ethers.utils.getAddress("0xF633b72A4C2Fb73b77A379bf72864A825aD35b6D");
const users = [
  ethers.utils.getAddress("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"),
  ethers.utils.getAddress("0x718648C8c531F91b528A7757dD2bE813c3940608"),
];
const l1Tokens = [daiAddress, wethAddress];
const startBlock = 30475928;
const endBlock = 30477298;

describe("PoolEventState", function () {
  let provider: Provider;
  let client: PoolEventState;
  before(async () => {
    provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    const instance = hubPool.connect(hubPoolAddress, provider);
    client = new PoolEventState(instance, startBlock);
  });
  it("read events", async function () {
    const result = await client.read(endBlock);
    const nodupe = await client.read(endBlock);
    assert.deepEqual(result, nodupe);
  });
});
describe("PoolClient", function () {
  const state = {};
  let provider: Provider;
  let client: Client;
  before(async () => {
    provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
    client = new Client(
      {
        hubPoolAddress,
        configStoreAddress,
        wethAddress,
        // if you have an archive node, set this to true
        hasArchive: true,
        acceleratingDistributorAddress,
        merkleDistributorAddress,
      },
      { provider },
      (path, data) => set(state, path, data)
    );
  });
  it("read users", async function () {
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
