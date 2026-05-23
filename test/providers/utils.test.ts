import { createSendErrorWithMessage } from "../../src/providers/utils";
import { expect } from "../utils";

describe("createSendErrorWithMessage", () => {
  const wrapperMessage = "Not enough providers succeeded.";

  it("returns an actual Error instance", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, new Error("inner"));
    // Regression: previously returned a plain object via `{ ...sendError, ...new Error(message) }`,
    // which failed downstream `instanceof Error` checks and degraded error logging.
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
    // The rejection reasons fed in from `Promise.allSettled` need not be Error instances --
    // e.g. SolanaError-like plain objects, primitives, etc. They must still survive on `.cause`.
    const reason = { name: "SolanaError", context: { __code: -32000, __serverMessage: "boom" } };
    const wrapped = createSendErrorWithMessage(wrapperMessage, reason);
    expect(wrapped.cause).to.equal(reason);
  });

  it("does not silently drop properties of an Error rejection reason", () => {
    // The previous implementation spread `{ ...sendError, ...new Error(message) }`. Because
    // Error's own `message`/`stack`/`name` are non-enumerable in V8, spreading them yielded
    // `{}` -- which combined with a generic `new Error(...)` rejection reason produced a fully
    // empty thrown object. Make sure we keep enough context to debug from now on.
    const inner = new Error("RPC provider reverted for method sendTransaction");
    const wrapped = createSendErrorWithMessage(wrapperMessage, inner);
    expect(wrapped.message).to.equal(wrapperMessage);
    expect((wrapped.cause as Error).message).to.equal(inner.message);
  });
});
