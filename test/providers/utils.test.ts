import { createSendErrorWithMessage, summarizeProviderError } from "../../src/providers/utils";
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

describe("summarizeProviderError", () => {
  it("returns 'unknown error' for null/undefined", () => {
    expect(summarizeProviderError(undefined)).to.equal("unknown error");
    expect(summarizeProviderError(null)).to.equal("unknown error");
  });

  it("passes string errors through", () => {
    expect(summarizeProviderError("connection refused")).to.equal("connection refused");
  });

  it("surfaces the JSON-RPC error message when the body is parseable", () => {
    // Shape produced by ethers' StaticJsonRpcProvider for SERVER_ERROR responses: `reason` + `body`
    // live directly on the error, with the upstream JSON-RPC envelope inside `body`.
    const ethersErr = {
      reason: "processing response error",
      code: "SERVER_ERROR",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 71,
        error: {
          code: 3,
          message: "execution reverted: ERC20: burn amount exceeds balance",
          data: "0x08c379a0",
        },
      }),
      // The URL with API key lives in `.message` / `.stack`; helper must not surface either.
      message:
        'processing response error (body="…", url="https://arb-mainnet.g.alchemy.com/v2/secret_api_key_here", code=SERVER_ERROR)',
    };
    const summary = summarizeProviderError(ethersErr);
    expect(summary).to.equal("execution reverted: ERC20: burn amount exceeds balance");
    expect(summary).to.not.include("alchemy");
    expect(summary).to.not.include("api_key");
  });

  it("also parses a nested ethers error (err.error with body)", () => {
    const ethersErr = {
      reason: "processing response error",
      code: "SERVER_ERROR",
      // Some ethers paths nest the RpcError shape one level down.
      error: {
        reason: "processing response error",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 3, message: "execution reverted: custom error", data: null },
        }),
      },
    };
    expect(summarizeProviderError(ethersErr)).to.equal("execution reverted: custom error");
  });

  it("falls back to .reason when the body is missing or unparseable", () => {
    const ethersErr = {
      reason: "processing response error",
      code: "SERVER_ERROR",
      body: "not json",
      message: 'processing response error (url="https://eth-mainnet.alchemyapi.io/v2/secret_api_key_here")',
    };
    const summary = summarizeProviderError(ethersErr);
    expect(summary).to.equal("processing response error");
    expect(summary).to.not.include("alchemy");
  });

  it("falls back to .code when neither rpcError nor .reason is available", () => {
    expect(summarizeProviderError({ code: "NETWORK_ERROR" })).to.equal("NETWORK_ERROR");
  });

  it("uses .message for non-ethers errors (no .code)", () => {
    expect(summarizeProviderError(new Error("Response failed validation"))).to.equal("Response failed validation");
  });

  it("never surfaces .message for ethers-shaped errors (URL leak guard)", () => {
    const ethersErr = {
      code: "SERVER_ERROR",
      message:
        'processing response error (url="https://eth-mainnet.alchemyapi.io/v2/secret_api_key_here", code=SERVER_ERROR)',
    };
    const summary = summarizeProviderError(ethersErr);
    expect(summary).to.equal("SERVER_ERROR");
    expect(summary).to.not.include("secret_api_key_here");
  });
});
