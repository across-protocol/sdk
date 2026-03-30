/**
 * This file re-exports some of the typechain bindings so that they can be tree-shaken in the final frontend bundle.
 * Currently, the packages `@across-protocol/contracts` is not optimized for tree-shaking and contains modules that
 * are not compatible in a browser environment. This is a temporary solution until we can fix the issue upstream.
 */

// Common types from local typechain
export type { TypedEvent, TypedEventFilter } from "./utils/abi/typechain/common";

// Factories from local typechain (generated from Foundry artifacts)
export { AcrossConfigStore__factory } from "./utils/abi/typechain/factories/AcrossConfigStore__factory";
export { HubPool__factory } from "./utils/abi/typechain/factories/HubPool__factory";
export { SpokePool__factory } from "./utils/abi/typechain/factories/SpokePool__factory";
export { ERC20__factory } from "./utils/abi/typechain/factories/ERC20__factory";

// Type exports from local typechain
export type { AcrossConfigStore, AcrossConfigStoreInterface } from "./utils/abi/typechain/AcrossConfigStore";
export type { HubPool, HubPoolInterface } from "./utils/abi/typechain/HubPool";
export type {
  SpokePool,
  SpokePoolInterface,
  V3FundsDepositedEvent,
  FilledV3RelayEvent,
} from "./utils/abi/typechain/SpokePool";
