import { ethers } from "ethers";
import { RetryProvider } from "../../src/providers";
import { expect } from "../utils";

const chainId = 1;
const providerCacheNamespace = "test-cache-ns";
const quorumError = "Not enough providers agreed to meet quorum";

const makeLog = (logIndex: string) => ({
  address: "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096",
  blockNumber: "0x1",
  logIndex,
  topics: [],
  data: "0x",
});

function makeProvider(quorumThreshold: number, behaviors: (unknown | Error)[]): RetryProvider {
  const params = behaviors.map(
    (_, i): ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider> => [
      `https://test${i}.example.com`,
      chainId,
    ]
  );
  const provider = new RetryProvider(
    params,
    chainId,
    quorumThreshold,
    0, // retries
    0, // delay
    1, // maxConcurrency
    providerCacheNamespace,
    0 // pctRpcCallsLogged
  );
  provider.providers.forEach((subProvider, i) => {
    const behavior = behaviors[i];
    subProvider.send = () => (behavior instanceof Error ? Promise.reject(behavior) : Promise.resolve(behavior));
  });
  return provider;
}

describe("RetryProvider quorum", () => {
  it("throws the quorum error, not a ReferenceError, when providers disagree and no fallbacks remain", async () => {
    const provider = makeProvider(2, [[makeLog("0x1")], []]);

    let caught: unknown;
    try {
      await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
      expect.fail("Expected send to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.not.be.instanceOf(ReferenceError);
    expect((caught as Error).message).to.include(quorumError);
  });

  it("throws the quorum error when a failing provider consumes the fallback and the survivors disagree", async () => {
    const provider = makeProvider(2, [new Error("rpc down"), [makeLog("0x1")], [makeLog("0x2")]]);

    let caught: unknown;
    try {
      await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
      expect.fail("Expected send to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.not.be.instanceOf(ReferenceError);
    expect((caught as Error).message).to.include(quorumError);
    expect((caught as Error).message).to.include("rpc down");
  });

  it("returns the quorum result when enough providers agree after a fallback query", async () => {
    const agreed = [makeLog("0x1")];
    const provider = makeProvider(2, [agreed, [makeLog("0x2")], agreed]);

    const result = await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
    expect(result).to.deep.equal(agreed);
  });
});
