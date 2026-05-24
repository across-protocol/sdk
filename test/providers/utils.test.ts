import { createSendErrorWithMessage, diffRpcResults, LogDiff } from "../../src/providers/utils";
import { expect } from "../utils";

describe("diffRpcResults", () => {
  describe("eth_getLogs", () => {
    const baseLog = {
      address: "0xef684c38f94f48775959ecf2012d7e864ffb9dd4",
      blockHash: "0xabc",
      blockNumber: "0x2beaad0",
      data: "0xdeadbeef",
      logIndex: "0x0",
      removed: false,
      topics: ["0xf4ad92585b1bc117fbdd644990adf0827bc4c95baeae8a23322af807b6d0020e"],
      transactionHash: "0xfeedface",
      transactionIndex: "0x1",
    };

    it("strips the same fields compareRpcResults strips", () => {
      const a = [{ ...baseLog, blockTimestamp: "0x1", transactionLogIndex: "0x0" }];
      const b = [{ ...baseLog, blockTimestamp: "0x2", transactionLogIndex: "0xff" }];
      const diff = diffRpcResults("eth_getLogs", a, b) as LogDiff;
      expect(diff.differing).to.deep.equal([]);
      expect(diff.onlyInA).to.deep.equal([]);
      expect(diff.onlyInB).to.deep.equal([]);
    });

    it("reports logs only present in one provider's result", () => {
      const extra = { ...baseLog, transactionHash: "0xextra", logIndex: "0x2" };
      const diff = diffRpcResults("eth_getLogs", [baseLog], [baseLog, extra]) as LogDiff;
      expect(diff.onlyInB).to.have.lengthOf(1);
      expect(diff.onlyInB[0].key).to.equal("0xextra:0x2");
      expect(diff.onlyInA).to.deep.equal([]);
      expect(diff.differing).to.deep.equal([]);
      expect(diff.totalA).to.equal(1);
      expect(diff.totalB).to.equal(2);
    });

    it("reports per-field differences for logs present in both", () => {
      const a = [{ ...baseLog, data: "0xaa" }];
      const b = [{ ...baseLog, data: "0xbb" }];
      const diff = diffRpcResults("eth_getLogs", a, b) as LogDiff;
      expect(diff.differing).to.have.lengthOf(1);
      expect(diff.differing[0].key).to.equal(`${baseLog.transactionHash}:${baseLog.logIndex}`);
      expect(diff.differing[0].fieldDiffs).to.deep.equal({ data: { a: "0xaa", b: "0xbb" } });
    });

    it("truncates and reports a dropped count when buckets exceed the cap", () => {
      const many = Array.from({ length: 12 }, (_, i) => ({
        ...baseLog,
        transactionHash: `0x${i.toString(16).padStart(64, "0")}`,
        logIndex: `0x${i.toString(16)}`,
      }));
      const diff = diffRpcResults("eth_getLogs", [], many) as LogDiff;
      expect(diff.onlyInB).to.have.lengthOf(5);
      expect(diff.truncated?.onlyInB).to.equal(7);
    });

    it("handles undefined inputs without throwing", () => {
      const diff = diffRpcResults("eth_getLogs", undefined, [baseLog]) as LogDiff;
      expect(diff.totalA).to.equal(0);
      expect(diff.totalB).to.equal(1);
      expect(diff.onlyInB).to.have.lengthOf(1);
    });
  });

  describe("eth_getBlockByNumber", () => {
    const baseBlock = {
      number: "0x10",
      hash: "0xblock",
      parentHash: "0xparent",
      transactions: ["0xtx"],
      stateRoot: "0xstate",
    };

    it("returns an empty diff when only ignored fields differ", () => {
      const a = { ...baseBlock, miner: "0x111", logsBloom: "0x0", totalDifficulty: "0x1" };
      const b = { ...baseBlock, miner: "0x222", logsBloom: "0xff", totalDifficulty: "0x2" };
      const diff = diffRpcResults("eth_getBlockByNumber", a, b) as Record<string, unknown>;
      expect(diff).to.deep.equal({});
    });

    it("emits per-key { a, b } pairs for non-ignored differences", () => {
      const a = { ...baseBlock, stateRoot: "0xstateA" };
      const b = { ...baseBlock, stateRoot: "0xstateB", extraData: "0xextra" };
      const diff = diffRpcResults("eth_getBlockByNumber", a, b) as Record<string, { a: unknown; b: unknown }>;
      expect(diff).to.deep.equal({
        stateRoot: { a: "0xstateA", b: "0xstateB" },
        extraData: { a: undefined, b: "0xextra" },
      });
    });
  });

  describe("generic methods", () => {
    it("returns an empty diff for equal values", () => {
      const diff = diffRpcResults("eth_blockNumber", "0x1", "0x1") as Record<string, unknown>;
      expect(diff).to.deep.equal({});
    });

    it("reports the path to a differing leaf", () => {
      const a = { receipt: { status: "0x1", logs: [{ data: "0xaa" }] } };
      const b = { receipt: { status: "0x1", logs: [{ data: "0xbb" }] } };
      const diff = diffRpcResults("eth_getTransactionReceipt", a, b) as Record<string, { a: unknown; b: unknown }>;
      expect(diff).to.deep.equal({ "receipt.logs[0].data": { a: "0xaa", b: "0xbb" } });
    });

    it("reports primitive disagreement at the root", () => {
      const diff = diffRpcResults("eth_blockNumber", "0x1", "0x2") as Record<string, { a: unknown; b: unknown }>;
      expect(diff).to.deep.equal({ ".": { a: "0x1", b: "0x2" } });
    });

    it("reports type mismatch between object and array", () => {
      const diff = diffRpcResults("eth_getBalance", { x: 1 }, [1]) as Record<string, { a: unknown; b: unknown }>;
      expect(diff).to.deep.equal({ ".": { a: { x: 1 }, b: [1] } });
    });
  });
});

describe("createSendErrorWithMessage", () => {
  const wrapperMessage = "Not enough providers succeeded.";

  it("returns an actual Error instance", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, new Error("inner"));
    expect(wrapped).to.be.instanceOf(Error);
  });

  it("preserves the wrapper message and stack", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, new Error("inner"));
    expect(wrapped.message).to.equal(wrapperMessage);
    expect(wrapped.stack)
      .to.be.a("string")
      .and.satisfy((stack: string) => stack.includes(wrapperMessage));
  });

  it("propagates the underlying error on `cause`", () => {
    const inner = new Error("inner");
    const wrapped = createSendErrorWithMessage(wrapperMessage, inner);
    expect(wrapped.cause).to.equal(inner);
  });

  it("propagates non-Error rejection reasons on `cause`", () => {
    const reason = { name: "SolanaError", context: { __code: -32000, __serverMessage: "boom" } };
    const wrapped = createSendErrorWithMessage(wrapperMessage, reason);
    expect(wrapped.cause).to.equal(reason);
  });

  it("does not silently drop properties of an Error rejection reason", () => {
    const inner = new Error("RPC provider reverted for method sendTransaction");
    const wrapped = createSendErrorWithMessage(wrapperMessage, inner);
    expect(wrapped.message).to.equal(wrapperMessage);
    expect((wrapped.cause as Error).message).to.equal(inner.message);
  });
});
