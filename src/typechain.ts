/**
 * This file re-exports some of the typechain bindings so that they can be tree-shaken in the final frontend bundle.
 * Currently, the packages `@across-protocol/contracts-v2` and `@across-protocol/across-token` are not optimized for tree-shaking
 * and contain modules that are not compatible in a browser environment. This is a temporary solution until we can fix the issue upstream.
 */
import type { TypedEvent, TypedEventFilter } from "@across-protocol/contracts-v2/dist/typechain/common";

export type { TypedEvent, TypedEventFilter };
export { AcrossMerkleDistributor__factory } from "@across-protocol/contracts-v2/dist/typechain/factories/contracts/merkle-distributor/AcrossMerkleDistributor__factory";
export { AcrossConfigStore__factory } from "@across-protocol/contracts-v2/dist/typechain/factories/contracts/AcrossConfigStore__factory";
export { HubPool__factory } from "@across-protocol/contracts-v2/dist/typechain/factories/contracts/HubPool__factory";
export { SpokePool__factory } from "@across-protocol/contracts-v2/dist/typechain/factories/contracts/SpokePool.sol/SpokePool__factory";
export { ERC20__factory } from "@across-protocol/contracts-v2/dist/typechain/factories/@openzeppelin/contracts/token/ERC20/ERC20__factory";

export { AcceleratingDistributor__factory } from "@across-protocol/across-token/dist/typechain/factories/AcceleratingDistributor__factory";
export { ClaimAndStake__factory } from "@across-protocol/across-token/dist/typechain/factories/ClaimAndStake__factory";
export { MerkleDistributor__factory } from "@across-protocol/across-token/dist/typechain/factories/MerkleDistributor__factory";

export type {
  AcrossMerkleDistributor,
  AcrossMerkleDistributorInterface,
} from "@across-protocol/contracts-v2/dist/typechain/contracts/merkle-distributor/AcrossMerkleDistributor";
export type {
  AcrossConfigStore,
  AcrossConfigStoreInterface,
} from "@across-protocol/contracts-v2/dist/typechain/contracts/AcrossConfigStore";
export type { HubPool, HubPoolInterface } from "@across-protocol/contracts-v2/dist/typechain/contracts/HubPool";
export type {
  SpokePool,
  SpokePoolInterface,
  FundsDepositedEvent,
  FilledRelayEvent,
  RequestedSpeedUpDepositEvent,
  V3FundsDepositedEvent,
  FilledV3RelayEvent,
} from "@across-protocol/contracts-v2/dist/typechain/contracts/SpokePool.sol/SpokePool";

export type {
  AcceleratingDistributor,
  AcceleratingDistributorInterface,
} from "@across-protocol/across-token/dist/typechain/AcceleratingDistributor";
export type { ClaimAndStake, ClaimAndStakeInterface } from "@across-protocol/across-token/dist/typechain/ClaimAndStake";
export type {
  MerkleDistributor,
  MerkleDistributorInterface,
} from "@across-protocol/across-token/dist/typechain/MerkleDistributor";
