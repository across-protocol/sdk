import { RpcTransport } from "@solana/rpc-spec";
import { SolanaRpcApi } from "@solana/kit";
import {
  isSolanaError,
  SVM_SLOT_SKIPPED,
  SVM_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SVM_TRANSACTION_PREFLIGHT_FAILURE,
} from "../../arch/svm";

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

export type TransactionResult = {
  err: string | undefined;
  logs: Array<string>;
  postExecutionAccounts: ExecutionAccounts[];
  preExecutionAccounts: ExecutionAccounts[];
  returnData: string | undefined;
  unitsConsumed: bigint;
};

export type ExecutionAccounts = {
  data: [string, string];
  executable: boolean;
  lamports: bigint;
  owner: string;
  rentEpoch: bigint;
  space: bigint;
};

// `simulateBundle` minimal response struct.
export type SolanaBundleSimulation = {
  context: { apiVersion: string; slot: bigint };
  value: {
    summary: "succeeded" | { failed: { error: { TransactionFailure: [Array<bigint>, string] }; tx_signature: string } };
    transactionResults: Array<TransactionResult>;
  };
};

export type SimulationOpts = {
  simulationBank?: string;
  skipSigVerify?: boolean;
  replaceRecentBlockhash?: boolean;
  accounts?: { addresses: string[]; encoding: string };
  // pre/post Execution accounts must be defined if any other opt is defined.
  preExecutionAccountsConfigs: Array<{ accountIndex: number; addresses: string[] } | undefined>;
  postExecutionAccountsConfigs: Array<{ accountIndex: number; addresses: string[] } | undefined>;
};

// Minimal extension of a Solana RPC Api which also supports some JITO RPC endpoints.
export interface JitoInterface extends SolanaRpcApi {
  // Simulate an array of base64 encoded transactions
  simulateBundle(transactions: { encodedTransactions: string[] }, opts?: SimulationOpts): SolanaBundleSimulation;
}

/**
 * Render an RPC error for log/wrap messages. For SolanaErrors, includes the numeric JSON-RPC
 * code alongside the server message; otherwise falls back to stack/toString.
 */
export function formatRpcError(error: unknown): string {
  if (isSolanaError(error)) {
    const { __code: code, __serverMessage: serverMessage } = error.context;
    const message = serverMessage ?? (error as { message?: string }).message ?? "";
    return `SolanaError [${code}]: ${message}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (error as any)?.stack || (error as any)?.toString?.() || String(error);
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
    case "sendTransaction":
      // Preflight failures are deterministic across providers; falling back only succeeds on RPCs that skip preflight.
      return code === SVM_TRANSACTION_PREFLIGHT_FAILURE;
    default:
      return false;
  }
}
