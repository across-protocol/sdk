import { RpcResponse, RpcTransport } from "@solana/kit";
import { expect } from "chai";
import winston from "winston";
import {
  SVM_BLOCK_NOT_AVAILABLE,
  SVM_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SVM_SLOT_SKIPPED,
} from "../../../src/arch/svm/provider";
import { CachedSolanaRpcFactory } from "../../../src/providers/solana/cachedRpcFactory";
import { QuorumFallbackSolanaRpcFactory } from "../../../src/providers/solana/quorumFallbackRpcFactory";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console({ silent: true })],
});

const chainId = 1234567890;
const providerCacheNamespace = "test-cache-ns";

const solanaError = (code: number, serverMessage = "synthetic") => ({
  name: "SolanaError",
  context: { __code: code, __serverMessage: serverMessage },
});

type RpcFactoryEntry = {
  transport: RpcTransport;
  rpcClient: unknown;
  rpcFactory: { clusterUrl: string };
};

function buildFactory(transports: RpcTransport[], quorumThreshold = 1) {
  const logger = silentLogger;
  const factoryParams = transports.map(
    (_, i): ConstructorParameters<typeof CachedSolanaRpcFactory> => [
      providerCacheNamespace,
      undefined,
      0, // retries
      0, // retryDelaySeconds
      1, // maxConcurrency
      0, // pctRpcCallsLogged
      logger,
      `https://test${i}.example.com/`,
      chainId,
    ]
  );

  const factory = new QuorumFallbackSolanaRpcFactory(factoryParams, quorumThreshold, logger);

  const replacement: RpcFactoryEntry[] = transports.map((transport, i) => ({
    transport,
    rpcClient: {},
    rpcFactory: { clusterUrl: `https://test${i}.example.com/` },
  }));
  (factory.rpcFactories as unknown as RpcFactoryEntry[]).length = 0;
  (factory.rpcFactories as unknown as RpcFactoryEntry[]).push(...replacement);

  return factory;
}

function rejectingTransport(error: unknown): RpcTransport {
  return (() => Promise.reject(error)) as unknown as RpcTransport;
}

function resolvingTransport(value: unknown): RpcTransport {
  return (() => Promise.resolve(value)) as unknown as RpcTransport;
}

function payload(method: string, params: unknown[] = []): Parameters<RpcTransport>[0] {
  return { payload: { method, params } } as unknown as Parameters<RpcTransport>[0];
}

describe("QuorumFallbackSolanaRpcFactory error preservation", () => {
  it("rethrows the underlying SolanaError when the only rejection is SVM_SLOT_SKIPPED on getBlockTime", async () => {
    const skipped = solanaError(SVM_SLOT_SKIPPED, "Slot 421829272 was skipped");
    const factory = buildFactory([rejectingTransport(skipped)]);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [421829272]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.equal(skipped);
    expect((caught as { context: { __code: number } }).context.__code).to.equal(SVM_SLOT_SKIPPED);
  });

  it("rethrows the underlying SolanaError for SVM_LONG_TERM_STORAGE_SLOT_SKIPPED on getBlock", async () => {
    const skipped = solanaError(SVM_LONG_TERM_STORAGE_SLOT_SKIPPED, "ledger jump to recent snapshot");
    const factory = buildFactory([rejectingTransport(skipped)]);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlock", [421829272]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.equal(skipped);
  });

  it("rethrows the SolanaError when every required-provider rejection is shouldFailImmediate", async () => {
    const skipped1 = solanaError(SVM_SLOT_SKIPPED, "from provider 1");
    const skipped2 = solanaError(SVM_SLOT_SKIPPED, "from provider 2");
    const factory = buildFactory([rejectingTransport(skipped1), rejectingTransport(skipped2)], 2);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [421829272]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.equal(skipped1);
  });

  it("still wraps the error when the failure is not shouldFailImmediate", async () => {
    const networkError = new Error("network down");
    const factory = buildFactory([rejectingTransport(networkError)]);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [421829272]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/Not enough providers succeeded/);
    expect((caught as Error).cause).to.equal(networkError);
  });

  it("still wraps the error for shouldFailImmediate codes on unrelated methods", async () => {
    const skipped = solanaError(SVM_SLOT_SKIPPED, "not really a skipped slot");
    const factory = buildFactory([rejectingTransport(skipped)]);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getAccountInfo", ["someAddress"]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/Not enough providers succeeded/);
    expect((caught as Error).cause).to.equal(skipped);
  });

  it("passes through to the wrapping path when only some rejections are shouldFailImmediate", async () => {
    const skipped = solanaError(SVM_SLOT_SKIPPED, "skipped");
    const network = new Error("network down");
    const factory = buildFactory([rejectingTransport(skipped), rejectingTransport(network)], 2);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [421829272]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/Not enough providers succeeded/);
  });

  it("includes the JSON-RPC error code in the wrap message for SolanaError rejections", async () => {
    // Regression: the previous wrap used `error.stack || error.toString()`, which on @solana/kit
    // SolanaErrors drops `context.__code` and only leaves the server message. When two providers
    // both fail with the canonical "Block not available for slot N" message, downstream readers
    // can't tell from the wrap whether the underlying code was -32004 (generic, inconclusive) or
    // some other code rendered with the same server text. Surface the code explicitly.
    const blockNotAvailable = solanaError(SVM_BLOCK_NOT_AVAILABLE, "Block not available for slot 422715124");
    const factory = buildFactory([rejectingTransport(blockNotAvailable), rejectingTransport(blockNotAvailable)], 2);

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [422715124]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/Not enough providers succeeded/);
    expect((caught as Error).message).to.include(`SolanaError [${SVM_BLOCK_NOT_AVAILABLE}]`);
    expect((caught as Error).message).to.include("Block not available for slot 422715124");
  });

  it("does not fall back when a required provider rejects with a shouldFailImmediate code", async () => {
    // Regression for production incident on 2026-06-03: when canonical chain slot 423907443 was
    // skipped, QuickNode/Alchemy/Chainstack all returned SVM_SLOT_SKIPPED, but the chain still
    // fell through to drpc/Helius. If any fallback returned a non-SolanaError (e.g. a timeout
    // wrapping a JSON parse failure), the post-allSettled `rejections.every(shouldFailImmediate)`
    // check was defeated and the SolanaError was wrapped in a plain Error, so the SVM_SLOT_SKIPPED
    // case in `_callGetTimestampForSlotWithRetry` never matched and `getNearestSlotTime` could
    // not advance to the next produced slot.
    const skipped1 = solanaError(SVM_SLOT_SKIPPED, "Slot 423907443 was skipped (provider 1)");
    const skipped2 = solanaError(SVM_SLOT_SKIPPED, "Slot 423907443 was skipped (provider 2)");
    let drpcCalled = false;
    let heliusCalled = false;
    const drpcTimeout: RpcTransport = (() => {
      drpcCalled = true;
      return Promise.reject(new Error("drpc timeout"));
    }) as unknown as RpcTransport;
    const heliusTimeout: RpcTransport = (() => {
      heliusCalled = true;
      return Promise.reject(new Error("helius timeout"));
    }) as unknown as RpcTransport;
    const factory = buildFactory(
      [rejectingTransport(skipped1), rejectingTransport(skipped2), drpcTimeout, heliusTimeout],
      2
    );

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getBlockTime", [423907443]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    // Both required providers' SolanaError shouldFailImmediate codes are preserved.
    expect(caught).to.equal(skipped1);
    expect((caught as { context: { __code: number } }).context.__code).to.equal(SVM_SLOT_SKIPPED);
    // And the fallback providers were never asked, saving RPC budget on a deterministic chain fact.
    expect(drpcCalled).to.equal(false);
    expect(heliusCalled).to.equal(false);
  });

  it("still tries fallback providers when SVM_LONG_TERM_STORAGE_SLOT_SKIPPED, in case an archival provider can answer", async () => {
    // SVM_LONG_TERM_STORAGE_SLOT_SKIPPED is provider-local: it can mean "this provider does not
    // have the slot in its long-term storage", not "the slot was skipped on the network". An
    // archival fallback (e.g. Helius) may still have the data, so we must not short-circuit it.
    const archivalMiss = solanaError(SVM_LONG_TERM_STORAGE_SLOT_SKIPPED, "missing in long-term storage");
    let archivalFallbackCalled = false;
    const archivalSuccess: RpcTransport = (() => {
      archivalFallbackCalled = true;
      return Promise.resolve({ result: 1735689600 } as unknown as RpcResponse<unknown>);
    }) as unknown as RpcTransport;
    const factory = buildFactory([rejectingTransport(archivalMiss), archivalSuccess], 1);

    const response = (await factory.createTransport()(payload("getBlockTime", [421829272]))) as RpcResponse<unknown>;

    expect(archivalFallbackCalled).to.equal(true);
    expect(response).to.deep.equal({ result: 1735689600 });
  });

  it("succeeds normally when the provider returns a result", async () => {
    const ok = (() => Promise.resolve({ result: "ok" })) as unknown as RpcTransport;
    const factory = buildFactory([ok]);

    const response = (await factory.createTransport()(payload("getBlockTime", [421829272]))) as RpcResponse<unknown>;
    expect(response).to.deep.equal({ result: "ok" });
  });
});

describe("QuorumFallbackSolanaRpcFactory lower-bound quorum on getSlot", () => {
  it("returns the K-th highest slot across N providers (rejects one lagging provider)", async () => {
    // Three providers, two of which agree the chain has reached at least 105_000.
    // Lower-bound quorum value should be 105_000 even though one provider lags at 100_000.
    const factory = buildFactory(
      [resolvingTransport(110_000n), resolvingTransport(105_000n), resolvingTransport(100_000n)],
      2
    );

    const response = await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
    expect(response).to.equal(105_000n);
  });

  it("rejects an outlier-high single provider when quorum is 2", async () => {
    // One provider reports a fake-high; two honest providers agree on the real tip.
    const factory = buildFactory(
      [resolvingTransport(9_000_000_000n), resolvingTransport(105_000n), resolvingTransport(104_998n)],
      2
    );

    const response = await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
    expect(response).to.equal(105_000n);
  });

  it("returns the min when only quorum providers respond successfully", async () => {
    // Quorum=2, three providers, but one errors out. The two successful responses both contribute,
    // and the K-th highest is the minimum of those two.
    const factory = buildFactory(
      [resolvingTransport(110_000n), resolvingTransport(105_000n), rejectingTransport(new Error("rpc down"))],
      2
    );

    const response = await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
    expect(response).to.equal(105_000n);
  });

  it("throws when fewer than quorum providers respond successfully", async () => {
    // Quorum=2 but only one provider succeeds — lower-bound quorum cannot be reached.
    const networkError = new Error("network down");
    const factory = buildFactory(
      [resolvingTransport(110_000n), rejectingTransport(networkError), rejectingTransport(networkError)],
      2
    );

    let caught: unknown;
    try {
      await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
      expect.fail("Expected the transport to reject");
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.match(/lower-bound quorum/i);
    expect((caught as Error).message).to.include("1/2");
  });

  it("returns identical-value agreement directly without divergence logging", async () => {
    // All providers agree exactly — the K-th highest is the single agreed-upon value.
    const factory = buildFactory(
      [resolvingTransport(105_000n), resolvingTransport(105_000n), resolvingTransport(105_000n)],
      2
    );

    const response = await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
    expect(response).to.equal(105_000n);
  });

  it("preserves the single-provider fast path when quorum is 1", async () => {
    // With quorum=1, lower-bound quorum is skipped — the first provider's response is returned
    // even if a later provider would have reported a higher slot.
    const factory = buildFactory(
      [resolvingTransport(100_000n), resolvingTransport(110_000n), resolvingTransport(105_000n)],
      1
    );

    const response = await factory.createTransport()(payload("getSlot", [{ commitment: "finalized" }]));
    expect(response).to.equal(100_000n);
  });
});
