import { createSendErrorWithMessage } from "../../src/providers/utils";
import { expect } from "../utils";

describe("createSendErrorWithMessage", () => {
  const wrapperMessage = "Not enough providers succeeded.";

  it("returns an actual Error instance", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, new Error("inner"));
    expect(wrapped).to.be.instanceOf(Error);
  });

  it("preserves the wrapper message and stack", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, new Error("inner"));
    expect(wrapped.message).to.equal(wrapperMessage);
    expect(wrapped.stack).to.be.a("string").and.satisfy((stack: string) => stack.includes(wrapperMessage));
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
