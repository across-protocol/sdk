import { createSendErrorWithMessage, getRevertReason, parseJsonRpcError } from "../../src/providers/utils";
import { expect } from "../utils";

// Reconstructs the ethers v5 SERVER_ERROR ("processing response error") object seen in production when an
// `eth_estimateGas` call reverts on-chain. The JSON-RPC error - including the ABI-encoded custom error
// selector - is carried on the `body` string, exactly as ethers surfaces it. `0x8f260c60` is the selector
// for the SpokePool custom error `RelayFilled()`.
function makeProcessingResponseError(data: string | null = "0x8f260c60"): Error {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 361,
    error: { code: 3, message: "execution reverted", data },
  });
  return Object.assign(new Error(`processing response error (body="${body}", ...)`), {
    reason: "processing response error",
    code: "SERVER_ERROR",
    body,
    error: { code: 3, data },
    requestMethod: "POST",
    url: "https://opt-mainnet.g.alchemy.com",
  });
}

describe("parseJsonRpcError", () => {
  it("extracts the JSON-RPC error (code/message/data) from an ethers SERVER_ERROR", () => {
    const parsed = parseJsonRpcError(makeProcessingResponseError());
    expect(parsed).to.deep.equal({ code: 3, message: "execution reverted", data: "0x8f260c60" });
  });

  it("extracts a revert with null data", () => {
    const parsed = parseJsonRpcError(makeProcessingResponseError(null));
    expect(parsed).to.deep.equal({ code: 3, message: "execution reverted", data: null });
  });

  it("returns undefined for a plain Error with no JSON-RPC body", () => {
    expect(parseJsonRpcError(new Error("connection refused"))).to.equal(undefined);
  });

  it("returns undefined for a non-object", () => {
    expect(parseJsonRpcError("execution reverted")).to.equal(undefined);
    expect(parseJsonRpcError(undefined)).to.equal(undefined);
  });
});

describe("getRevertReason", () => {
  it("surfaces the revert message and ABI-encoded selector (RelayFilled = 0x8f260c60)", () => {
    expect(getRevertReason(makeProcessingResponseError())).to.equal("execution reverted (0x8f260c60)");
  });

  it("omits the selector when the node returns no data", () => {
    expect(getRevertReason(makeProcessingResponseError(null))).to.equal("execution reverted");
  });

  it("returns undefined when the error is not a JSON-RPC revert", () => {
    expect(getRevertReason(new Error("connection refused"))).to.equal(undefined);
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

  // End-to-end: this is how RetryProvider.send wraps a failed required provider. The structured revert
  // remains recoverable from the wrapper via `cause`, so a caller never has to scrape the message string.
  it("keeps the revert reason recoverable from `cause` via parseJsonRpcError", () => {
    const wrapped = createSendErrorWithMessage(wrapperMessage, makeProcessingResponseError());
    expect(parseJsonRpcError(wrapped.cause)).to.deep.equal({
      code: 3,
      message: "execution reverted",
      data: "0x8f260c60",
    });
    expect(getRevertReason(wrapped.cause)).to.equal("execution reverted (0x8f260c60)");
  });
});
