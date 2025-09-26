import winston from "winston";
import { MockRateLimitedSolanaRpcFactory, MockSolanaRpcFactory, MockRetrySolanaRpcFactory } from "./mocks";
import { createSpyLogger, expect, spyLogIncludes } from "./utils";
import { RpcTransport, Signature } from "@solana/kit";

const chainId = 1234567890;
const url = "https://test.example.com/";
const maxConcurrency = 1;
const pctRpcCallsLogged = 100; // Will use logs to check underlying transport calls.
const retryDelaySeconds = 0.001; // Very short delay for tests

describe("retry solana provider", () => {
  let spy: sinon.SinonSpy;
  let spyLogger: winston.Logger;
  let mockRpcFactory: MockSolanaRpcFactory;

  beforeEach(() => {
    const spyLoggerResult = createSpyLogger();
    spy = spyLoggerResult.spy;
    spyLogger = spyLoggerResult.spyLogger;
    mockRpcFactory = new MockSolanaRpcFactory(url, chainId);
  });

  it("succeeds without retries on successful call", async () => {
    const retries = 3;
    const mockResult = 1;

    mockRpcFactory.setResult("getSlot", [], mockResult);
    const retryRpcClient = createRetryRpcClient(retries);

    const result = await retryRpcClient.getSlot().send();
    expect(result).to.equal(BigInt(mockResult));

    // Should only call the underlying transport once
    expect(spy.callCount).to.equal(1);
    expect(spyLogIncludes(spy, 0, "getSlot")).to.be.true;
  });

  it("retries on error and eventually succeeds", async () => {
    const retries = 3;
    const mockResult = 42;

    // Set up the mock to fail twice, then succeed BEFORE creating the retry client
    let callCount = 0;
    mockRpcFactory.createTransport = () => {
      return (() => {
        callCount++;
        if (callCount <= 2) {
          // Throw regular errors instead of returning JSON-RPC errors
          throw new Error("temporary error");
        }
        return { result: mockResult };
      }) as unknown as RpcTransport;
    };

    const retryRpcClient = createRetryRpcClient(retries);
    const result = await retryRpcClient.getSlot().send();
    expect(result).to.equal(BigInt(mockResult));

    // Should have made 3 calls total (2 failures + 1 success)
    expect(callCount).to.equal(3);

    // Should log the retry attempts (but not the successful final call)
    expect(spy.callCount).to.be.greaterThan(0);
  });

  it("fails after exhausting all retries", async () => {
    const retries = 2;
    const errorMessage = "persistent error";

    // Set up the mock to always fail BEFORE creating the retry client
    let callCount = 0;
    mockRpcFactory.createTransport = () => {
      return (() => {
        callCount++;
        throw new Error(errorMessage);
      }) as unknown as RpcTransport;
    };

    const retryRpcClient = createRetryRpcClient(retries);

    try {
      await retryRpcClient.getSlot().send();
      expect.fail("Expected an error to be thrown");
    } catch (error) {
      expect(error.message).to.equal(errorMessage);
    }

    // Should have made retries + 1 calls (original + retries)
    expect(callCount).to.equal(retries + 1);
  });

  it("works with zero retries", async () => {
    const retries = 0;
    const errorMessage = "immediate error";

    // Set up the mock to always fail BEFORE creating the retry client
    let callCount = 0;
    mockRpcFactory.createTransport = () => {
      return (() => {
        callCount++;
        throw new Error(errorMessage);
      }) as unknown as RpcTransport;
    };

    const retryRpcClient = createRetryRpcClient(retries);

    try {
      await retryRpcClient.getSlot().send();
      expect.fail("Expected an error to be thrown");
    } catch (error) {
      expect(error.message).to.equal(errorMessage);
    }

    // Should have made exactly 1 call (no retries)
    expect(callCount).to.equal(1);
  });

  it("handles different RPC methods", async () => {
    const retries = 1;
    const mockTransactionResult = {
      slot: 0n,
      transaction: "test-transaction",
      blockTime: null,
      meta: null,
    };

    // Set up mock to fail once then succeed BEFORE creating the retry client
    let callCount = 0;
    mockRpcFactory.createTransport = () => {
      return ((...args: Parameters<RpcTransport>) => {
        const { method } = args[0].payload as { method: string; params?: unknown[] };
        callCount++;

        if (callCount === 1) {
          throw new Error("temporary failure");
        }

        if (method === "getTransaction") {
          return { result: mockTransactionResult };
        }
        return { result: 1 };
      }) as unknown as RpcTransport;
    };

    const retryRpcClient = createRetryRpcClient(retries);

    // Test getTransaction method
    const result = await retryRpcClient
      .getTransaction("test-signature" as unknown as Signature, {
        commitment: "confirmed",
        encoding: "base58",
      })
      .send();
    expect(result).to.deep.equal(mockTransactionResult);
  });

  it("validates retry configuration", () => {
    // Test negative retries
    expect(() => {
      new MockRetrySolanaRpcFactory(
        createMockRateLimitedFactory(),
        -1, // invalid
        retryDelaySeconds,
        maxConcurrency,
        pctRpcCallsLogged,
        spyLogger,
        url,
        chainId
      );
    }).to.throw("retries cannot be < 0 and must be an integer");

    // Test non-integer retries
    expect(() => {
      new MockRetrySolanaRpcFactory(
        createMockRateLimitedFactory(),
        1.5, // invalid
        retryDelaySeconds,
        maxConcurrency,
        pctRpcCallsLogged,
        spyLogger,
        url,
        chainId
      );
    }).to.throw("retries cannot be < 0 and must be an integer");

    // Test negative delay
    expect(() => {
      new MockRetrySolanaRpcFactory(
        createMockRateLimitedFactory(),
        1,
        -0.1, // invalid
        maxConcurrency,
        pctRpcCallsLogged,
        spyLogger,
        url,
        chainId
      );
    }).to.throw("retryDelaySeconds cannot be < 0");
  });

  // Helper functions
  function createRetryRpcClient(retries: number) {
    const mockRateLimitedFactory = createMockRateLimitedFactory();

    const mockRetryFactory = new MockRetrySolanaRpcFactory(
      mockRateLimitedFactory,
      retries,
      retryDelaySeconds,
      maxConcurrency,
      pctRpcCallsLogged,
      spyLogger, // Use the shared spy logger from beforeEach
      url,
      chainId
    );

    return mockRetryFactory.createRpcClient();
  }

  function createMockRateLimitedFactory() {
    return new MockRateLimitedSolanaRpcFactory(
      mockRpcFactory, // Use the shared mock factory from beforeEach
      maxConcurrency,
      pctRpcCallsLogged,
      spyLogger, // Use the shared spy logger from beforeEach
      url,
      chainId
    );
  }
});
