/**
 * This file re-exports some of the typechain bindings so that they can be tree-shaken in the final frontend bundle.
 * Currently, the packages `@across-protocol/contracts` and `@across-protocol/across-token` are not optimized for tree-shaking
 * and contain modules that are not compatible in a browser environment. This is a temporary solution until we can fix the issue upstream.
 */

// Common types from local typechain
export type { TypedEvent, TypedEventFilter } from "./utils/abi/typechain/common";

// Factories from local typechain (generated from Foundry artifacts)
export { AcrossMerkleDistributor__factory } from "./utils/abi/typechain/factories/AcrossMerkleDistributor__factory";
export { AcrossConfigStore__factory } from "./utils/abi/typechain/factories/AcrossConfigStore__factory";
export { HubPool__factory } from "./utils/abi/typechain/factories/HubPool__factory";
export { SpokePool__factory } from "./utils/abi/typechain/factories/SpokePool__factory";
export { ERC20__factory } from "./utils/abi/typechain/factories/ERC20__factory";

// Type exports from local typechain
export type {
  AcrossMerkleDistributor,
  AcrossMerkleDistributorInterface,
} from "./utils/abi/typechain/AcrossMerkleDistributor";
export type { AcrossConfigStore, AcrossConfigStoreInterface } from "./utils/abi/typechain/AcrossConfigStore";
export type { HubPool, HubPoolInterface } from "./utils/abi/typechain/HubPool";
export type {
  SpokePool,
  SpokePoolInterface,
  V3FundsDepositedEvent,
  FilledV3RelayEvent,
} from "./utils/abi/typechain/SpokePool";

// Continue importing from @across-protocol/across-token (no Foundry artifacts available)
export { AcceleratingDistributor__factory } from "@across-protocol/across-token/dist/typechain/factories/AcceleratingDistributor__factory";
export { ClaimAndStake__factory } from "@across-protocol/across-token/dist/typechain/factories/ClaimAndStake__factory";
export { MerkleDistributor__factory } from "@across-protocol/across-token/dist/typechain/factories/MerkleDistributor__factory";

export type {
  AcceleratingDistributor,
  AcceleratingDistributorInterface,
} from "@across-protocol/across-token/dist/typechain/AcceleratingDistributor";
export type { ClaimAndStake, ClaimAndStakeInterface } from "@across-protocol/across-token/dist/typechain/ClaimAndStake";
export type {
  MerkleDistributor,
  MerkleDistributorInterface,
} from "@across-protocol/across-token/dist/typechain/MerkleDistributor";
