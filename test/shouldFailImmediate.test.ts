import {
  SVM_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SVM_SLOT_SKIPPED,
  SVM_TRANSACTION_PREFLIGHT_FAILURE,
} from "../src/arch/svm/provider";
import { shouldFailImmediate } from "../src/providers/solana/utils";
import { expect } from "./utils";

const solanaError = (code: number, context: Record<string, unknown> = {}) => ({
  name: "SolanaError",
  context: { __code: code, ...context },
});

describe("shouldFailImmediate", () => {
  it("returns false for non-Solana errors", () => {
    expect(shouldFailImmediate("sendTransaction", new Error("network down"))).to.be.false;
    expect(shouldFailImmediate("getBlock", { foo: "bar" })).to.be.false;
  });

  describe("getBlock / getBlockTime", () => {
    for (const method of ["getBlock", "getBlockTime"] as const) {
      it(`${method}: short-circuits on SVM_SLOT_SKIPPED`, () => {
        expect(shouldFailImmediate(method, solanaError(SVM_SLOT_SKIPPED))).to.be.true;
      });

      it(`${method}: short-circuits on SVM_LONG_TERM_STORAGE_SLOT_SKIPPED`, () => {
        expect(shouldFailImmediate(method, solanaError(SVM_LONG_TERM_STORAGE_SLOT_SKIPPED))).to.be.true;
      });

      it(`${method}: does not short-circuit on other codes`, () => {
        expect(shouldFailImmediate(method, solanaError(SVM_TRANSACTION_PREFLIGHT_FAILURE))).to.be.false;
        expect(shouldFailImmediate(method, solanaError(-32000))).to.be.false;
      });
    }
  });

  describe("sendTransaction", () => {
    it("short-circuits on preflight simulation failure", () => {
      expect(shouldFailImmediate("sendTransaction", solanaError(SVM_TRANSACTION_PREFLIGHT_FAILURE))).to.be.true;
    });

    it("does not short-circuit on other Solana errors", () => {
      expect(shouldFailImmediate("sendTransaction", solanaError(SVM_SLOT_SKIPPED))).to.be.false;
      expect(shouldFailImmediate("sendTransaction", solanaError(-32000))).to.be.false;
    });
  });

  it("returns false for unhandled methods", () => {
    expect(shouldFailImmediate("getAccountInfo", solanaError(SVM_TRANSACTION_PREFLIGHT_FAILURE))).to.be.false;
    expect(shouldFailImmediate("getSlot", solanaError(SVM_SLOT_SKIPPED))).to.be.false;
  });
});
