import { describeSolanaError, SVM_TRANSACTION_PREFLIGHT_FAILURE, SVM_SLOT_SKIPPED } from "../src/arch/svm/provider";
import { expect } from "./utils";

describe("describeSolanaError", () => {
  it("returns an empty object for non-Solana errors", () => {
    expect(describeSolanaError(new Error("regular"))).to.deep.equal({});
    expect(describeSolanaError("oops")).to.deep.equal({});
    expect(describeSolanaError(undefined)).to.deep.equal({});
    expect(describeSolanaError(null)).to.deep.equal({});
    expect(describeSolanaError({ random: "object" })).to.deep.equal({});
  });

  it("extracts name, code, and context from a SolanaError-like object", () => {
    const err = {
      name: "SolanaError",
      context: {
        __code: SVM_TRANSACTION_PREFLIGHT_FAILURE,
        logs: ["Program log: refund leaf already executed"],
        accounts: null,
        unitsConsumed: 4321,
      },
    };

    const result = describeSolanaError(err);
    expect(result.solanaError).to.not.be.undefined;
    expect(result.solanaError?.name).to.equal("SolanaError");
    expect(result.solanaError?.code).to.equal(SVM_TRANSACTION_PREFLIGHT_FAILURE);
    expect(result.solanaError?.context).to.deep.equal(err.context);
    // message field is only populated for real Error instances; the plain object form omits it.
    expect(result.solanaError?.message).to.be.undefined;
  });

  it("populates `message` when the input is an Error instance", () => {
    class FakeSolanaError extends Error {
      readonly name = "SolanaError";
      readonly context = { __code: SVM_SLOT_SKIPPED };
    }
    const err = new FakeSolanaError("Slot was skipped");

    const result = describeSolanaError(err);
    expect(result.solanaError?.message).to.equal("Slot was skipped");
  });

  it("recursively describes a SolanaError cause", () => {
    const inner = {
      name: "SolanaError",
      context: { __code: 4615001, index: 3 },
    };
    const outer = {
      name: "SolanaError",
      context: { __code: SVM_TRANSACTION_PREFLIGHT_FAILURE, logs: ["Program log: x"] },
      cause: inner,
    };

    const result = describeSolanaError(outer);
    expect(result.solanaError?.cause).to.deep.equal({
      name: "SolanaError",
      code: 4615001,
      context: inner.context,
    });
  });

  it("falls back to { message } when the cause is a non-Solana Error", () => {
    const outer = {
      name: "SolanaError",
      context: { __code: SVM_TRANSACTION_PREFLIGHT_FAILURE },
      cause: new Error("network blip"),
    };

    const result = describeSolanaError(outer);
    expect(result.solanaError?.cause).to.deep.equal({ message: "network blip" });
  });

  it("omits cause when the SolanaError has no cause", () => {
    const err = {
      name: "SolanaError",
      context: { __code: SVM_SLOT_SKIPPED },
    };

    const result = describeSolanaError(err);
    expect(result.solanaError?.cause).to.be.undefined;
  });

  it("survives JSON serialization round-trips (structurally cloned error)", () => {
    const err = JSON.parse(
      JSON.stringify({
        name: "SolanaError",
        context: { __code: SVM_TRANSACTION_PREFLIGHT_FAILURE, logs: ["a", "b"] },
        cause: {
          name: "SolanaError",
          context: { __code: 4615001 },
        },
      })
    );

    const result = describeSolanaError(err);
    expect(result.solanaError?.code).to.equal(SVM_TRANSACTION_PREFLIGHT_FAILURE);
    expect(result.solanaError?.cause).to.deep.include({ code: 4615001 });
  });
});
