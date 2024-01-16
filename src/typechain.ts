/**
 * This file re-exports some of the typechain bindings so that they can be tree-shaken in the final frontend bundle.
 * Currently, the packages `@across-protocol/contracts-v2` and `@across-protocol/across-token` are not optimized for tree-shaking
 * and contain modules that are not compatible in a browser environment. This is a temporary solution until we can fix the issue upstream.
 */
import { BigNumber, BigNumberish, BytesLike } from "ethers";
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

/**
 * Temporarily provide local definitions for the upcoming v3 data types.
 * This defers the need to bump contracts-v2, which would otherwise be
 * incompatible with the production code in relayer-v2. These defintions
 * must be removed when contracts-v2 is finally bumped.
 */

export interface V3FundsDepositedEventObject {
  inputToken: string;
  outputToken: string;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
  destinationChainId: BigNumber;
  depositId: number;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  depositor: string;
  recipient: string;
  exclusiveRelayer: string;
  message: string;
}
export type V3FundsDepositedEvent = TypedEvent<
  [
    string,
    string,
    BigNumber,
    BigNumber,
    BigNumber,
    number,
    number,
    number,
    number,
    string,
    string,
    string,
    string
  ],
  V3FundsDepositedEventObject
>;

export interface FilledV3RelayEventObject {
  inputToken: string;
  outputToken: string;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
  repaymentChainId: BigNumber;
  originChainId: BigNumber;
  depositId: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusiveRelayer: string;
  relayer: string;
  depositor: string;
  recipient: string;
  message: string;
  relayExecutionInfo: V3SpokePoolInterface.V3RelayExecutionEventInfoStructOutput;
}
export type FilledV3RelayEvent = TypedEvent<
  [
    string,
    string,
    BigNumber,
    BigNumber,
    BigNumber,
    BigNumber,
    number,
    number,
    number,
    string,
    string,
    string,
    string,
    string,
    V3SpokePoolInterface.V3RelayExecutionEventInfoStructOutput
  ],
  FilledV3RelayEventObject
>;

export interface RequestedSpeedUpV3DepositEventObject {
  updatedOutputAmount: BigNumber;
  depositId: number;
  depositor: string;
  updatedRecipient: string;
  updatedMessage: string;
  depositorSignature: string;
}
export type RequestedSpeedUpV3DepositEvent = TypedEvent<
  [BigNumber, number, string, string, string, string],
  RequestedSpeedUpV3DepositEventObject
>;

export type RequestedSpeedUpV3DepositEventFilter =
  TypedEventFilter<RequestedSpeedUpV3DepositEvent>;

export interface RequestedV3SlowFillEventObject {
  inputToken: string;
  outputToken: string;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
  originChainId: BigNumber;
  depositId: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusiveRelayer: string;
  depositor: string;
  recipient: string;
  message: string;
}
export type RequestedV3SlowFillEvent = TypedEvent<
  [
    string,
    string,
    BigNumber,
    BigNumber,
    BigNumber,
    number,
    number,
    number,
    string,
    string,
    string,
    string
  ],
  RequestedV3SlowFillEventObject
>;

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace V3SpokePoolInterface {
  type V3RelayExecutionEventInfoStruct = {
    updatedRecipient: string;
    updatedMessage: BytesLike;
    updatedOutputAmount: BigNumberish;
    fillType: BigNumberish;
  };
  type V3RelayExecutionEventInfoStructOutput = [string, string, BigNumber, number] & {
    updatedRecipient: string;
    updatedMessage: string;
    updatedOutputAmount: BigNumber;
    fillType: number;
  };
  type V3RelayerRefundLeafStruct = {
    amountToReturn: BigNumberish;
    chainId: BigNumberish;
    refundAmounts: BigNumberish[];
    leafId: BigNumberish;
    l2TokenAddress: string;
    refundAddresses: string[];
    fillsRefundedRoot: BytesLike;
    fillsRefundedHash: string;
  };
  type V3RelayerRefundLeafStructOutput = [
    BigNumber,
    BigNumber,
    BigNumber[],
    number,
    string,
    string[],
    string,
    string,
  ] & {
    amountToReturn: BigNumber;
    chainId: BigNumber;
    refundAmounts: BigNumber[];
    leafId: number;
    l2TokenAddress: string;
    refundAddresses: string[];
    fillsRefundedRoot: string;
    fillsRefundedHash: string;
  };
  type V3RelayDataStruct = {
    depositor: string;
    recipient: string;
    exclusiveRelayer: string;
    inputToken: string;
    outputToken: string;
    inputAmount: BigNumberish;
    outputAmount: BigNumberish;
    originChainId: BigNumberish;
    depositId: BigNumberish;
    fillDeadline: BigNumberish;
    exclusivityDeadline: BigNumberish;
    message: BytesLike;
  };
  type V3RelayDataStructOutput = [
    string,
    string,
    string,
    string,
    string,
    BigNumber,
    BigNumber,
    BigNumber,
    number,
    number,
    number,
    string,
  ] & {
    depositor: string;
    recipient: string;
    exclusiveRelayer: string;
    inputToken: string;
    outputToken: string;
    inputAmount: BigNumber;
    outputAmount: BigNumber;
    originChainId: BigNumber;
    depositId: number;
    fillDeadline: number;
    exclusivityDeadline: number;
    message: string;
  };
  type V3SlowFillStruct = {
    relayData: V3SpokePoolInterface.V3RelayDataStruct;
    chainId: BigNumberish;
    updatedOutputAmount: BigNumberish;
  };
  type V3SlowFillStructOutput = [V3SpokePoolInterface.V3RelayDataStructOutput, BigNumber, BigNumber] & {
    relayData: V3SpokePoolInterface.V3RelayDataStructOutput;
    chainId: BigNumber;
    updatedOutputAmount: BigNumber;
  };
}
