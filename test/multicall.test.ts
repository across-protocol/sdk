import { CHAIN_IDs } from "@across-protocol/constants";
import { getMulticall3, getMulticallAddress } from "../src/utils/Multicall";
import { expect } from "./utils";
import { waffle } from "hardhat";

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

describe("getMulticall3", () => {
  it("should return undefined for an unsupported chainId", () => {
    const chainId = 100; // Unsupported chain (Mumbai)
    const provider = waffle.provider;
    const multicall = getMulticall3(chainId, provider);

    expect(multicall).to.be.undefined;
  });

  it("should return a Multicall3 instance for a supported chainId", () => {
    const chainId = CHAIN_IDs.ARBITRUM;
    const provider = waffle.provider;
    const multicall = getMulticall3(chainId, provider);

    expect(multicall).to.not.be.undefined;

    expect(multicall?.aggregate).to.be.a("function");
  });
});
