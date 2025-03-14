import {
  signature,
  Commitment,
  Rpc,
  SolanaRpcApiFromTransport,
  RpcTransport,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
} from "@solana/kit";
import bs58 from "bs58";
import { createHash } from "crypto";
import winston from "winston";
import { MockRateLimitedSolanaRpcFactory, MockSolanaRpcFactory, MockCachedSolanaRpcFactory } from "./mocks";
import { createSpyLogger, expect, spyLogIncludes } from "./utils";
import { MemoryCacheClient } from "../src/caching";
import { jsonReviverWithBigInts } from "../src/utils";

const chainId = 1234567890;
const url = "https://test.example.com/";
const maxConcurrency = 1;
const pctRpcCallsLogged = 100; // Will use logs to check underlying transport calls.
const providerCacheNamespace = "test";
const testSignature = signature(bs58.encode(createHash("sha512").update("testSignature").digest()));
const getSignatureStatusesParams = [[testSignature], { searchTransactionHistory: true }];
const getTransactionConfig = {
  commitment: "confirmed" as Commitment,
  encoding: "base58" as const,
};
const getTransactionResult = {
  slot: 0n,
  transaction: bs58.encode(Buffer.from("testTransaction")),
  blockTime: null,
  meta: null,
};
const errorCode = SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR; // Need real error code, otherwise error generation will fail.
const errorMessage = "test error message";
const jsonRpcError = { code: errorCode, message: errorMessage };

describe("cached solana provider", () => {
  let spy: sinon.SinonSpy;
  let mockRpcFactory: MockSolanaRpcFactory;
  let memoryCache: MemoryCacheClient;
  let cachedRpcClient: Rpc<SolanaRpcApiFromTransport<RpcTransport>>;

  beforeEach(() => {
    const spyLoggerResult = createSpyLogger();
    spy = spyLoggerResult.spy;

    mockRpcFactory = new MockSolanaRpcFactory(url, chainId);
    const rateLimitedParams: [number, number, winston.Logger, string, number] = [
      maxConcurrency,
      pctRpcCallsLogged,
      spyLoggerResult.spyLogger,
      url,
      chainId,
    ];
    const rateLimitedRpcFactory = new MockRateLimitedSolanaRpcFactory(mockRpcFactory, ...rateLimitedParams);
    memoryCache = new MemoryCacheClient();
    cachedRpcClient = new MockCachedSolanaRpcFactory(
      rateLimitedRpcFactory,
      providerCacheNamespace,
      memoryCache,
      ...rateLimitedParams
    ).createRpcClient();
  });

  it("caches finalized transaction", async () => {
    // Prepare required mock results for finalized transaction.
    mockRpcFactory.setResult("getSignatureStatuses", getSignatureStatusesParams, {
      value: [{ confirmationStatus: "finalized" }],
    });
    mockRpcFactory.setResult("getTransaction", [testSignature, getTransactionConfig], getTransactionResult);

    let result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Check the cache.
    const cacheKey = `${providerCacheNamespace},${
      new URL(url).hostname
    },${chainId}:getTransaction,["${testSignature}",${JSON.stringify(getTransactionConfig)}]`;
    const cacheValue = JSON.parse((await memoryCache.get(cacheKey)) || "{}", jsonReviverWithBigInts);
    expect(cacheValue).to.have.property("result");
    expect(cacheValue.result).to.deep.equal(getTransactionResult);

    // Expect 2 log entries from the underlying transport: one for getSignatureStatuses and one for getTransaction.
    expect(spy.callCount).to.equal(2);
    expect(spyLogIncludes(spy, 0, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 1, "getTransaction")).to.be.true;

    // Second request should fetch from cache.
    result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // No new log entries should be emitted from the underlying transport, expect the same 2 as after the first request.
    expect(spy.callCount).to.equal(2);
  });

  it("does not cache non-finalized transaction", async () => {
    // Prepare required mock results for non-finalized transaction.
    mockRpcFactory.setResult("getSignatureStatuses", getSignatureStatusesParams, {
      value: [{ confirmationStatus: "processed" }],
    });
    mockRpcFactory.setResult("getTransaction", [testSignature, getTransactionConfig], getTransactionResult);

    let result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Check the cache is empty.
    const cacheKey = `${providerCacheNamespace},${
      new URL(url).hostname
    },${chainId}:getTransaction,["${testSignature}",${JSON.stringify(getTransactionConfig)}]`;
    const cacheValue = JSON.parse((await memoryCache.get(cacheKey)) || "{}", jsonReviverWithBigInts);
    expect(cacheValue).to.be.empty;

    // Expect 2 log entries from the underlying transport: one for getSignatureStatuses and one for getTransaction.
    expect(spy.callCount).to.equal(2);
    expect(spyLogIncludes(spy, 0, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 1, "getTransaction")).to.be.true;

    result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Second request should have triggered the underlying transport again, doubling the log entries.
    expect(spy.callCount).to.equal(4);
    expect(spyLogIncludes(spy, 2, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 3, "getTransaction")).to.be.true;
  });

  it("does not cache other methods", async () => {
    let slotResult = 1;
    mockRpcFactory.setResult("getSlot", [], slotResult);

    let rpcResult = await cachedRpcClient.getSlot().send();
    expect(rpcResult).to.equal(BigInt(slotResult));

    // Expect 1 log entry from the underlying transport.
    expect(spy.callCount).to.equal(1);
    expect(spyLogIncludes(spy, 0, "getSlot")).to.be.true;

    slotResult = 2;
    mockRpcFactory.setResult("getSlot", [], slotResult);
    rpcResult = await cachedRpcClient.getSlot().send();
    expect(rpcResult).to.equal(BigInt(slotResult));

    // Second request should have triggered the underlying transport again, doubling the log entries.
    expect(spy.callCount).to.equal(2);
    expect(spyLogIncludes(spy, 1, "getSlot")).to.be.true;
  });

  it("does not cache error responses", async () => {
    // Prepare required mock responses.
    mockRpcFactory.setResult("getSignatureStatuses", getSignatureStatusesParams, {
      value: [{ confirmationStatus: "finalized" }],
    });
    mockRpcFactory.setError("getTransaction", [testSignature, getTransactionConfig], jsonRpcError);

    try {
      await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
      expect.fail("Expected an error to be thrown");
    } catch (error) {
      expect(error.context.__code).to.equal(errorCode);
      expect(error.context.__serverMessage).to.equal(errorMessage);
    }

    // Check the cache is empty.
    const cacheKey = `${providerCacheNamespace},${
      new URL(url).hostname
    },${chainId}:getTransaction,["${testSignature}",${JSON.stringify(getTransactionConfig)}]`;
    const cacheValue = JSON.parse((await memoryCache.get(cacheKey)) || "{}", jsonReviverWithBigInts);
    expect(cacheValue).to.be.empty;
  });

  it("does not cache when json-rpc error in getting signature status", async () => {
    // Prepare required mock responses.
    mockRpcFactory.setError("getSignatureStatuses", getSignatureStatusesParams, jsonRpcError);
    mockRpcFactory.setResult("getTransaction", [testSignature, getTransactionConfig], getTransactionResult);

    // Only the getSignatureStatuses call returns error, the getTransaction call should still succeed.
    let result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Check the cache is empty.
    const cacheKey = `${providerCacheNamespace},${
      new URL(url).hostname
    },${chainId}:getTransaction,["${testSignature}",${JSON.stringify(getTransactionConfig)}]`;
    const cacheValue = JSON.parse((await memoryCache.get(cacheKey)) || "{}", jsonReviverWithBigInts);
    expect(cacheValue).to.be.empty;

    // Expect 2 log entries from the underlying transport: one for getSignatureStatuses and one for getTransaction.
    expect(spy.callCount).to.equal(2);
    expect(spyLogIncludes(spy, 0, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 1, "getTransaction")).to.be.true;

    result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Second request should have triggered the underlying transport again, doubling the log entries.
    expect(spy.callCount).to.equal(4);
    expect(spyLogIncludes(spy, 2, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 3, "getTransaction")).to.be.true;
  });

  it("does not cache when thrown in getting signature status", async () => {
    // Prepare required mock responses.
    const throwMessage = "test throw message";
    mockRpcFactory.setThrow("getSignatureStatuses", getSignatureStatusesParams, throwMessage);
    mockRpcFactory.setResult("getTransaction", [testSignature, getTransactionConfig], getTransactionResult);

    // Only the getSignatureStatuses call throws, the getTransaction call should still succeed.
    let result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Check the cache is empty.
    const cacheKey = `${providerCacheNamespace},${
      new URL(url).hostname
    },${chainId}:getTransaction,["${testSignature}",${JSON.stringify(getTransactionConfig)}]`;
    const cacheValue = JSON.parse((await memoryCache.get(cacheKey)) || "{}", jsonReviverWithBigInts);
    expect(cacheValue).to.be.empty;

    // Expect 2 log entries from the underlying transport: one for getSignatureStatuses and one for getTransaction.
    expect(spy.callCount).to.equal(2);
    expect(spyLogIncludes(spy, 0, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 1, "getTransaction")).to.be.true;

    result = await cachedRpcClient.getTransaction(testSignature, getTransactionConfig).send();
    expect(result).to.deep.equal(getTransactionResult);

    // Second request should have triggered the underlying transport again, doubling the log entries.
    expect(spy.callCount).to.equal(4);
    expect(spyLogIncludes(spy, 2, "getSignatureStatuses")).to.be.true;
    expect(spyLogIncludes(spy, 3, "getTransaction")).to.be.true;
  });
});
