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

export type SolanaErrorDescription = {
  name: string;
  message?: string;
  code: number;
  context: SolanaErrorLike["context"];
  cause?: SolanaErrorDescription | { message: string };
};

/**
 * Extract a log-friendly description of a SolanaError. Returns `{}` for non-SolanaError
 * inputs so callers can spread unconditionally:
 *   logger.error({ at, message, error: err, ...describeSolanaError(err) });
 *
 * Most JSON loggers serialize Errors via `.stack`/`.message`, dropping SolanaError's
 * `context` (program logs, accounts, unitsConsumed) and `cause` (wrapped TransactionError /
 * InstructionError). This produces a plain object that survives any standard serializer.
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
