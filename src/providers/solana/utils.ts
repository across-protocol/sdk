import { RpcTransport } from "@solana/rpc-spec";
import { isSolanaError, SVM_SLOT_SKIPPED, SVM_LONG_TERM_STORAGE_SLOT_SKIPPED } from "../../arch/svm";

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

/**
 * Determine whether a Solana RPC error indicates an unrecoverable error that should not be retried.
 * @param method RPC method name.
 * @param error Error object from the RPC call.
 * @returns True if the request should be aborted immediately, otherwise false.
 */
export function shouldFailImmediate(method: string, error: unknown): boolean {
  if (!isSolanaError(error)) {
    return false;
  }

  // JSON-RPC errors: https://www.quicknode.com/docs/solana/error-references
  const { __code: code } = error.context;
  switch (method) {
    case "getBlock":
    case "getBlockTime":
      // No block at the requested slot. This may not be correct for blocks > 1 year old.
      return [SVM_SLOT_SKIPPED, SVM_LONG_TERM_STORAGE_SLOT_SKIPPED].includes(code);
    default:
      return false;
  }
}
