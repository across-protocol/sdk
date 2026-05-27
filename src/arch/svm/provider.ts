import { isSolanaError as _isSolanaError } from "@solana/kit";
import { is, type, number, string } from "superstruct";

/**
 * SVM RPC provider error codes
 * See https://www.quicknode.com/docs/solana/error-references
 */
export {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE as SVM_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED as SVM_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED as SVM_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE as SVM_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";

/**
 * Superstruct schema for validating SolanaError structure.
 * Handles serialized errors that have lost their prototype chain.
 * Uses partial validation to allow additional properties in the context object.
 */
const SolanaErrorStruct = type({
  name: string(),
  context: type({
    __code: number(),
  }),
});

/**
 * Type definition for SolanaError structure.
 * Includes common context properties for better type inference.
 */
export interface SolanaErrorLike {
  name: string;
  context: {
    __code: number;
    __serverMessage?: string;
    statusCode?: number;
    [key: string]: unknown;
  };
  cause?: unknown;
}

/**
 * Enhanced type guard to check if an error is a SolanaError.
 *
 * This function uses a two-tier approach:
 * 1. First attempts the official instanceof-based check from @solana/kit
 * 2. Falls back to structural validation using superstruct for errors that have been
 *    serialized/deserialized (e.g., when crossing async boundaries or through JSON parsing)
 *
 * @param error The error to check
 * @param code Optional error code to match against context.__code
 * @returns True if the error is a SolanaError (or has valid SolanaError structure)
 */
export function isSolanaError(error: unknown): error is SolanaErrorLike {
  return _isSolanaError(error) || is(error, SolanaErrorStruct);
}

/**
 * Structured description of a SolanaError suitable for logging.
 *
 * `code` and `context` mirror the underlying SolanaError's `context.__code` and `context` —
 * `context` carries the rich diagnostic payload for typed errors (e.g. for
 * `SVM_TRANSACTION_PREFLIGHT_FAILURE`, the `RpcSimulateTransactionResult` with `logs[]`,
 * `accounts`, `returnData`, `unitsConsumed`). `cause` is recursively described when the
 * underlying cause is itself a SolanaError (e.g. the `TransactionError` /
 * `InstructionError` wrapped inside a preflight failure).
 */
export type SolanaErrorDescription = {
  name: string;
  message?: string;
  code: number;
  context: SolanaErrorLike["context"];
  cause?: SolanaErrorDescription | { message: string };
};

/**
 * Extract a structured, log-friendly description of a SolanaError. Returns `{}` for
 * anything that isn't a SolanaError so callers can spread the result unconditionally.
 *
 * Motivation: most JSON logger formatters either (a) replace an `Error` field with its
 * `.stack` string or (b) JSON.stringify it, which drops `context` and `cause` on
 * SolanaErrors because those are own enumerable properties on the SolanaError instance
 * but the loggers consult `.stack`/`.message` instead. This helper produces a plain
 * object holding the fields you actually need to diagnose an SVM failure (program logs,
 * underlying instruction error, etc.) that survives any standard serializer.
 *
 * @example
 * try { await sendAndConfirmSolanaTransaction(tx, provider); }
 * catch (err) {
 *   logger.error({ at: "...", message: "...", error: err, ...describeSolanaError(err) });
 * }
 */
export function describeSolanaError(err: unknown): { solanaError?: SolanaErrorDescription } {
  if (!isSolanaError(err)) {
    return {};
  }
  const solanaError: SolanaErrorDescription = {
    name: err.name,
    code: err.context.__code,
    context: err.context,
  };
  if (err instanceof Error) {
    solanaError.message = err.message;
  }
  if (err.cause !== undefined) {
    const describedCause = describeSolanaError(err.cause);
    if (describedCause.solanaError) {
      solanaError.cause = describedCause.solanaError;
    } else if (err.cause instanceof Error) {
      solanaError.cause = { message: err.cause.message };
    }
  }
  return { solanaError };
}
