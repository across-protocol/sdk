// SVM (Solana) utilities — moved from @across-protocol/contracts
// See ACP-56 for context on this migration.

// Re-export SVM types
export * from "./types.svm";

// web3-v1 (Anchor/web3.js v1) — all utils
export * from "./web3-v1";

// web3-v2 (Solana Kit) — re-export non-conflicting names directly,
// alias conflicting ones with V2 suffix to avoid name collision with web3-v1.
export {
  readFillEventFromFillStatusPda,
  signAndSendTransaction,
  createDefaultTransaction,
  createLookupTable,
  extendLookupTable,
} from "./web3-v2";
export type { RpcClient } from "./web3-v2";
export {
  readProgramEvents as readProgramEventsV2,
  readEvents as readEventsV2,
  sendTransactionWithLookupTable as sendTransactionWithLookupTableV2,
} from "./web3-v2";

// Auto-generated assets (IDL definitions and Anchor types)
export * from "./assets";

// Auto-generated Codama clients
export * from "./clients";
