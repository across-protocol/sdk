import { GetSlotApi } from "@solana/web3.js";
import { MockRateLimitedSolanaRpcFactory, MockSolanaRpcFactory } from "./mocks";
import { createSpyLogger, expect } from "./utils";

const chainId = 1234567890;
const url = "https://test.example.com/";

describe("rate limited solana provider", () => {
  it("serial requests updates results", async () => {
    const numRequests = 10;
    const maxConcurrency = 1;
    const pctRpcCallsLogged = 0;
    let mockResult = 0;
    const mockResponseTime = 10;

    // Update the mock result at the same rate as the response time.
    const mockRpcFactory = new MockSolanaRpcFactory(url, chainId);
    mockRpcFactory.setResponseTime(mockResponseTime);
    const interval = setInterval(() => {
      mockRpcFactory.setResult(mockResult);
      mockResult += 1;
    }, mockResponseTime);

    const rateLimitedRpcClient = new MockRateLimitedSolanaRpcFactory(
      mockRpcFactory,
      maxConcurrency,
      pctRpcCallsLogged,
      undefined,
      url,
      chainId
    ).createRpcClient();

    const rateLimitedRequests = Array.from({ length: numRequests }, () => rateLimitedRpcClient.getSlot().send());
    const results = await Promise.all(rateLimitedRequests);
    clearInterval(interval); // Stop updating results

    // The total difference between the first and the last result should be 1 less than the number of requests as the
    // mock results are updated at the same rate as the response time and this test has concurrency of 1.
    const expectedTotalDiff = BigInt(numRequests - 1);
    expect(results[results.length - 1] - results[0]).to.equal(expectedTotalDiff);
  });

  it("concurrent requests get the same result", async () => {
    const numRequests = 10;
    const maxConcurrency = numRequests;
    const pctRpcCallsLogged = 0;
    let mockResult = 0;
    const mockResponseTime = 10;

    // Update the mock result at the same rate as the response time.
    const mockRpcFactory = new MockSolanaRpcFactory(url, chainId);
    mockRpcFactory.setResponseTime(mockResponseTime);
    const interval = setInterval(() => {
      mockRpcFactory.setResult(mockResult);
      mockResult += 1;
    }, mockResponseTime);

    const rateLimitedRpcClient = new MockRateLimitedSolanaRpcFactory(
      mockRpcFactory,
      maxConcurrency,
      pctRpcCallsLogged,
      undefined,
      url,
      chainId
    ).createRpcClient();

    const rateLimitedRequests = Array.from({ length: numRequests }, () => rateLimitedRpcClient.getSlot().send());
    const results = await Promise.all(rateLimitedRequests);
    clearInterval(interval); // Stop updating results

    // The last and the first result should be the same as the mock result is updated at the same rate as the response
    // time and this test has concurrency equal to the number of requests.
    expect(results[results.length - 1]).to.equal(results[0]);
  });

  it("logs rate limited request", async () => {
    const maxConcurrency = 1;
    const pctRpcCallsLogged = 100;
    const mockResult = 1;
    const { spy, spyLogger } = createSpyLogger();
    const mockRpcFactory = new MockSolanaRpcFactory(url, chainId);
    const rateLimitedRpcClient = new MockRateLimitedSolanaRpcFactory(
      mockRpcFactory,
      maxConcurrency,
      pctRpcCallsLogged,
      spyLogger,
      url,
      chainId
    ).createRpcClient();

    mockRpcFactory.setResult(mockResult);

    const getSlotParams: Parameters<GetSlotApi["getSlot"]> = [{ commitment: "confirmed" }];
    await rateLimitedRpcClient.getSlot(getSlotParams[0]).send();

    expect(spy.calledOnce).to.be.true;
    expect(spy.getCall(0).lastArg.provider).to.equal(new URL(url).origin);
    expect(spy.getCall(0).lastArg.chainId).to.equal(chainId);
    expect(spy.getCall(0).lastArg.method).to.equal("getSlot");
    expect(spy.getCall(0).lastArg.params).to.deep.equal(getSlotParams);
  });
});
