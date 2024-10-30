import { any, literal, nullable, number, string, type, union } from "superstruct";

export type RPCProvider = "ALCHEMY" | "DRPC" | "INFURA" | "INFURA_DIN";
export type RPCTransport = "https" | "wss";

// JSON-RPC 2.0 Error object
// See JSON-RPC 2.0 Specification section 5 Reponse object
// https://www.jsonrpc.org/specification
export const JsonRpcError = type({
  jsonrpc: literal("2.0"),
  id: union([number(), string()]),
  error: type({
    code: number(),
    message: string(),
    data: nullable(any()),
  }),
});

// Generic/unknown RPC error (may embed a JsonRpcError).
export const RpcError = type({
  reason: string(),
  body: string(),
});
