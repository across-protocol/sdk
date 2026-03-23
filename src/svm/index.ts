// SVM (Solana) utilities — moved from @across-protocol/contracts
// See ACP-56 for context on this migration.

// Re-export SVM types
export * from "./types.svm";

// web3-v1 (Anchor/web3.js v1) — selective top-level exports
// (matches the original @across-protocol/contracts public API)
// Additional web3-v1 utils are accessible via deep imports:
//   import { ... } from "@across-protocol/sdk/dist/cjs/src/svm/web3-v1"
export {
  AcrossPlusMessageCoder,
  calculateRelayHashUint8Array,
  findProgramAddress,
  MulticallHandlerCoder,
  relayerRefundHashFn,
} from "./web3-v1";

// web3-v2 (Solana Kit) — all exports
export * from "./web3-v2";

// Auto-generated assets (IDL definitions and Anchor types)
export * from "./assets";

// Auto-generated Codama clients
export * from "./clients";
