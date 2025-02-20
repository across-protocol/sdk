import { RpcTransport } from "@solana/rpc-spec";

/**
 * This is the type we pass to define a Solana RPC request "task".
 */
export interface SolanaRateLimitTask {
  // These are the arguments to be passed to base transport when making the RPC request.
  rpcArgs: Parameters<RpcTransport>;

  // These are the promise callbacks that will cause the initial RPC call made by the user to either return a result
  // or fail.
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}
