export { isSolanaError } from "@solana/kit";

/**
 * SVM RPC provider error codes
 * See https://www.quicknode.com/docs/solana/error-references
 */

// Timeout; recommended to retry.
export const SVM_BLOCK_NOT_AVAILABLE = -32004;

// No block produced for slot.
export const SVM_NO_BLOCK_AT_SLOT = -32007;
