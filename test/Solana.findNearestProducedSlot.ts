import winston from "winston";
import { MockRateLimitedSolanaRpcFactory, MockRetrySolanaRpcFactory, MockSolanaRpcFactory } from "./mocks";
import { createSpyLogger, expect, spyLogIncludes } from "./utils";
import { findNearestProducedSlot } from "../src/arch/svm/SpokeUtils";

const chainId = 1234567890;
const url = "https://test.example.com/";
const maxConcurrency = 1;
const pctRpcCallsLogged = 100; // Log every underlying transport call so spy.callCount is reliable.
const retries = 0;
const retryDelaySeconds = 0;

// Match the default config that @solana/kit attaches when no commitment is passed.
const defaultGetBlocksConfig = { commitment: "confirmed" };

describe("findNearestProducedSlot", () => {
  let spy: sinon.SinonSpy;
  let spyLogger: winston.Logger;
  let mockRpcFactory: MockSolanaRpcFactory;
  let provider: ReturnType<MockRetrySolanaRpcFactory["createRpcClient"]>;

  beforeEach(() => {
    const spyLoggerResult = createSpyLogger();
    spy = spyLoggerResult.spy;
    spyLogger = spyLoggerResult.spyLogger;

    mockRpcFactory = new MockSolanaRpcFactory(url, chainId);

    const mockRateLimitedRpcFactory = new MockRateLimitedSolanaRpcFactory(
      mockRpcFactory,
      maxConcurrency,
      pctRpcCallsLogged,
      spyLogger,
      url,
      chainId
    );
    const mockRetryRpcFactory = new MockRetrySolanaRpcFactory(
      mockRateLimitedRpcFactory,
      retries,
      retryDelaySeconds,
      maxConcurrency,
      pctRpcCallsLogged,
      spyLogger,
      url,
      chainId
    );
    provider = mockRetryRpcFactory.createRpcClient();
  });

  it("returns the largest produced slot in the initial window", async () => {
    const target = 1100n;
    // window = 4 -> initial range is [1097, 1100].
    mockRpcFactory.setResult("getBlocks", [1097, 1100, defaultGetBlocksConfig], [1097, 1099]);

    const found = await findNearestProducedSlot(provider, target, { window: 4 });
    expect(found).to.equal(1099n);
    expect(spy.callCount).to.equal(1);
    expect(spyLogIncludes(spy, 0, "getBlocks")).to.be.true;
  });

  it("iterates backward when no block is produced in the initial window", async () => {
    const target = 1100n;
    // First window [1097, 1100] is empty -> iterate to [1093, 1096] -> finds 1094.
    mockRpcFactory.setResult("getBlocks", [1097, 1100, defaultGetBlocksConfig], []);
    mockRpcFactory.setResult("getBlocks", [1093, 1096, defaultGetBlocksConfig], [1094]);

    const found = await findNearestProducedSlot(provider, target, { window: 4 });
    expect(found).to.equal(1094n);
    expect(spy.callCount).to.equal(2);
  });

  it("returns undefined when no produced slot is found within the iteration bound", async () => {
    const target = 100n;
    // All three windows are empty: [97,100], [93,96], [89,92].
    mockRpcFactory.setResult("getBlocks", [97, 100, defaultGetBlocksConfig], []);
    mockRpcFactory.setResult("getBlocks", [93, 96, defaultGetBlocksConfig], []);
    mockRpcFactory.setResult("getBlocks", [89, 92, defaultGetBlocksConfig], []);

    const found = await findNearestProducedSlot(provider, target, { window: 4, maxIterations: 3 });
    expect(found).to.equal(undefined);
    expect(spy.callCount).to.equal(3);
  });

  it("stops descending past slot 0", async () => {
    const target = 5n;
    // window = 32 -> clamps lower to 0 -> single empty range, then returns undefined.
    mockRpcFactory.setResult("getBlocks", [0, 5, defaultGetBlocksConfig], []);

    const found = await findNearestProducedSlot(provider, target, { window: 32 });
    expect(found).to.equal(undefined);
    expect(spy.callCount).to.equal(1);
  });
});
