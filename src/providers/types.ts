import { number, string, type } from "superstruct";

export type RPCProvider = "ALCHEMY" | "DRPC" | "INFURA" | "INFURA_DIN";
export type RPCTransport = "https" | "wss";

export const JsonRpcError = type({
  error: type({
    code: number(),
    message: string(),
    // data is optional and has no reliable type, so skip it.
  }),
});

export const RpcError = type({
  reason: string(),
  body: string(),
});
