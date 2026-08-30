import { ethers } from "ethers";
import { Logger } from "winston";
import { RetryProvider } from "../../src/providers";
import { createSpyLogger, expect } from "../utils";

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

function makeProvider(quorumThreshold: number, behaviors: (unknown | Error)[], logger?: Logger): RetryProvider {
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
    0, // pctRpcCallsLogged
    undefined, // redisClient
    undefined, // standardTtlBlockDistance
    undefined, // noTtlBlockDistance
    undefined, // providerCacheTtl
    logger
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

  it("identifies the mismatched providers in the diagnostic log when quorum fails with no fallbacks", async () => {
    const { spy, spyLogger } = createSpyLogger();
    const provider = makeProvider(2, [[makeLog("0x1")], []], spyLogger);

    await expect(provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).to.be.rejectedWith(quorumError);

    const warnLog = spy
      .getCalls()
      .map((call) => call.lastArg)
      .find((log) => log.at === "ProviderUtils" && log.message.includes("mismatched"));
    expect(warnLog).to.exist;
    // The first provider's result is the most frequent, so the second provider is flagged as the mismatch.
    expect(warnLog.mismatchedProviders).to.deep.equal(["https://test1.example.com"]);
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
