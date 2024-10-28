import { object, number, string } from "superstruct";

export type RPCProvider = "ALCHEMY" | "DRPC" | "INFURA" | "INFURA_DIN";
export type RPCTransport = "https" | "wss";

export const JsonRpcError = object({
  error: object({
    code: number(),
    message: string(),
  }),
});

export const RpcError = object({
  reason: string()
});
