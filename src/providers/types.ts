import { literal, nullable, number, string, type, union } from "superstruct";

export type RPCProvider = "ALCHEMY" | "DRPC" | "INFURA" | "INFURA_DIN";
export type RPCTransport = "https" | "wss";

// JSON-RPC 2.0 Error object
// See 5.1 Error Object https://www.jsonrpc.org/specification
export const JsonRpcError = type({
  jsonrpc: literal("2.0"),
  id: union([number(), string()]),
  error: type({
    code: number(),
    message: string(),
    data: nullable(string()),
  }),
});

// Generic/unknown RPC error (may embed a JsonRpcError).
export const RpcError = type({
  reason: string(),
  body: string(),
});
