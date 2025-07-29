/**
 * SVM RPC provider error codes
 * See https://www.quicknode.com/docs/solana/error-references
 */
export {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE as SVM_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED as SVM_SLOT_SKIPPED,
} from "@solana/kit";
