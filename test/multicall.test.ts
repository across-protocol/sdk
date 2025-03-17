import { CHAIN_IDs } from "@across-protocol/constants";
import { blockAndAggregate, getMulticall3, getMulticallAddress, deploy } from "../src/utils/Multicall";
import { Multicall3 } from "../src/utils/abi/typechain";
import { ethers, expect, SignerWithAddress } from "./utils";

describe("getMulticallAddress", () => {
  it("should return the deterministic multicall address for a chain in DETERMINISTIC_MULTICALL_CHAINS", () => {
    const chainId = CHAIN_IDs.ARBITRUM;
    const address = getMulticallAddress(chainId);

    expect(address).to.be.eq("0xcA11bde05977b3631167028862bE2a173976CA11");
  });

  it("should return the non-deterministic multicall address for ZK_SYNC", () => {
    const chainId = CHAIN_IDs.ZK_SYNC;
    const address = getMulticallAddress(chainId);

    expect(address).to.be.eq("0xF9cda624FBC7e059355ce98a31693d299FACd963");
  });

  it("should return undefined for an unknown chainId", () => {
    const chainId = 9999; // random chain
    const address = getMulticallAddress(chainId);

    expect(address).to.be.undefined;
  });
});

describe("getMulticall3", async () => {
  const provider = (await ethers.getSigners()).at(0).provider;

  it("should return undefined for an unsupported chainId", () => {
    const chainId = 100; // Unsupported chain (Mumbai)
    const multicall = getMulticall3(chainId, provider);

    expect(multicall).to.be.undefined;
  });

  it("should return a Multicall3 instance for a supported chainId", () => {
    const chainId = CHAIN_IDs.ARBITRUM;
    const multicall = getMulticall3(chainId, provider);

    expect(multicall).to.not.be.undefined;

    expect(multicall?.aggregate).to.be.a("function");
  });
});

describe("Multicall3", function () {
  let provider: ethers.providers.Provider;
  let funder: SignerWithAddress;
  let multicall3: Multicall3;

  before(async function () {
    [funder] = await ethers.getSigners();
    await deploy(funder);
    provider = funder.provider!;
    multicall3 = getMulticall3((await provider.getNetwork()).chainId, provider)!;
  });

  it("blockAndAggregate", async function () {
    const blockNumber = await provider.getBlockNumber();
    let response = await blockAndAggregate(multicall3, [], blockNumber);
    expect(response.blockNumber).to.equal(blockNumber);
    expect(response.returnData.length).to.equal(0);

    await provider.send("evm_mine");
    response = await blockAndAggregate(multicall3, []);
    expect(response.blockNumber).to.equal(blockNumber + 1);
    expect(response.returnData.length).to.equal(0);
  });
});
