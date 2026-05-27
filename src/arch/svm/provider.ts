import { isSolanaError as _isSolanaError } from "@solana/kit";
import { is, type, number, string } from "superstruct";

// SVM RPC provider error codes. https://www.quicknode.com/docs/solana/error-references
export {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE as SVM_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED as SVM_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED as SVM_LONG_TERM_STORAGE_SLOT_SKIPPED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE as SVM_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";

// Structural shape check for SolanaErrors that lost their prototype (e.g. JSON round-trip).
const SolanaErrorStruct = type({
  name: string(),
  context: type({
    __code: number(),
  }),
});

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

// Falls back to structural check so deserialized SolanaErrors (no prototype) still match.
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
