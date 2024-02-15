import {
  Fill,
  FillType,
  V2Deposit,
  V2Fill,
  V2RelayData,
  V2SlowFillLeaf,
  V2SpeedUp,
  V3Deposit,
  V3Fill,
  V3RelayData,
  V3SlowFillLeaf,
  V3SpeedUp,
} from "../interfaces";
import { BN } from "./BigNumberUtils";
import { fixedPointAdjustment } from "./common";

// Lowest ConfigStore version where the V3 model is in effect. The version update to the following value should take
// place atomically with the SpokePool upgrade to V3 so that the dataworker knows what kind of MerkleLeaves to propose
// in root bundles (i.e. SlowFillLeaf has different shapes). The dataworker/relayer code can use the following isV3()
// function to separate logic for calling V3 vs. legacy methods.
export const V3_MIN_CONFIG_STORE_VERSION = 3;

export function isV3(version: number): boolean {
  return version >= V3_MIN_CONFIG_STORE_VERSION;
}

// Can be used with specific types, and will fully verify that the descriminating key is exclusive to the former.
// Example usage:
// let a: Fill = ...;
// if (isType<V2Fill, V3Fill>(a, "destinationToken")) {
//
// }
export function isType<T, U>(input: T | U, key: Exclude<keyof T, keyof U>): input is T {
  return (input as T)[key] !== undefined;
}

// Slightly less safe than isType. Used in wrapper functions due to limitations of typescript.
function unsafeIsType<T, U>(input: T | U, key: keyof T): input is T {
  return (input as T)[key] !== undefined;
}

type MinV2Deposit = Pick<V2Deposit, "originToken">;
type MinV3Deposit = Pick<V3Deposit, "inputToken">;
export function isV2Deposit<T extends MinV2Deposit, U extends MinV3Deposit>(deposit: T | U): deposit is T {
  return unsafeIsType<T, U>(deposit, "originToken");
}

export function isV3Deposit<T extends MinV3Deposit, U extends MinV2Deposit>(deposit: T | U): deposit is T {
  return unsafeIsType<T, U>(deposit, "inputToken");
}

type MinV2SpeedUp = Pick<V2SpeedUp, "newRelayerFeePct">;
type MinV3SpeedUp = Pick<V3SpeedUp, "updatedOutputAmount">;
export function isV2SpeedUp<T extends MinV2SpeedUp, U extends MinV3SpeedUp>(speedUp: T | U): speedUp is T {
  return unsafeIsType<T, U>(speedUp, "newRelayerFeePct");
}

export function isV3SpeedUp<T extends MinV3SpeedUp, U extends MinV2SpeedUp>(speedUp: T | U): speedUp is T {
  return unsafeIsType<T, U>(speedUp, "updatedOutputAmount");
}

type MinV2Fill = Pick<V2Fill, "destinationToken">;
type MinV3Fill = Pick<V3Fill, "inputToken">;
export function isV2Fill<T extends MinV2Fill, U extends MinV3Fill>(fill: T | U): fill is T {
  return unsafeIsType<T, U>(fill, "destinationToken");
}

export function isV3Fill<T extends MinV3Fill, U extends MinV2Fill>(fill: T | U): fill is T {
  return unsafeIsType<T, U>(fill, "inputToken");
}

type MinV2RelayData = Pick<V2RelayData, "destinationToken">;
type MinV3RelayData = Pick<V3RelayData, "outputToken">;
export function isV2RelayData<T extends MinV2RelayData, U extends MinV3RelayData>(relayData: T | U): relayData is T {
  return unsafeIsType<T, U>(relayData, "destinationToken");
}

export function isV3RelayData<T extends MinV3RelayData, U extends MinV2RelayData>(relayData: T | U): relayData is T {
  return unsafeIsType<T, U>(relayData, "outputToken");
}

export function isSlowFill(fill: Fill): boolean {
  return isV2Fill(fill) ? fill.updatableRelayData.isSlowRelay : fill.relayExecutionInfo.fillType === FillType.SlowFill;
}

type MinV2SlowFillLeaf = Pick<V2SlowFillLeaf, "payoutAdjustmentPct">;
type MinV3SlowFillLeaf = Pick<V3SlowFillLeaf, "updatedOutputAmount">;
export function isV2SlowFillLeaf<T extends MinV2SlowFillLeaf, U extends MinV3SlowFillLeaf>(
  slowFillLeaf: T | U
): slowFillLeaf is T {
  return unsafeIsType<T, U>(slowFillLeaf, "payoutAdjustmentPct");
}

export function isV3SlowFillLeaf<T extends MinV3SlowFillLeaf, U extends MinV2SlowFillLeaf>(
  slowFillLeaf: T | U
): slowFillLeaf is T {
  return unsafeIsType<T, U>(slowFillLeaf, "updatedOutputAmount");
}

export function getDepositInputToken<T extends MinV2Deposit, U extends MinV3Deposit>(deposit: T | U): string {
  return isV2Deposit(deposit) ? deposit.originToken : deposit.inputToken;
}

export function getDepositOutputToken<
  T extends Pick<V2Deposit, "destinationToken">,
  U extends Pick<V3Deposit, "outputToken">,
>(deposit: T | U): string {
  return unsafeIsType<T, U>(deposit, "destinationToken") ? deposit.destinationToken : deposit.outputToken;
}

export function getDepositInputAmount<T extends Pick<V2Deposit, "amount">, U extends Pick<V3Deposit, "inputAmount">>(
  deposit: T | U
): BN {
  return unsafeIsType<T, U>(deposit, "amount") ? deposit.amount : deposit.inputAmount;
}

export function getDepositOutputAmount<T extends Pick<V2Deposit, "amount">, U extends Pick<V3Deposit, "outputAmount">>(
  deposit: T | U
): BN {
  return unsafeIsType<T, U>(deposit, "amount") ? deposit.amount : deposit.outputAmount;
}

export function getFillOutputToken<T extends Pick<V2Fill, "destinationToken">, U extends Pick<V3Fill, "outputToken">>(
  fill: T | U
): string {
  return unsafeIsType<T, U>(fill, "destinationToken") ? fill.destinationToken : fill.outputToken;
}

// Returns the total output amount for a unique fill hash.
export function getFillOutputAmount<T extends Pick<V2Fill, "amount">, U extends Pick<V3Fill, "outputAmount">>(
  fill: T | U
): BN {
  return unsafeIsType<T, U>(fill, "amount") ? fill.amount : fill.outputAmount;
}

// Returns the amount filled by a particular fill event.
export function getFillAmount<T extends Pick<V2Fill, "fillAmount">, U extends Pick<V3Fill, "outputAmount">>(
  fill: T | U
): BN {
  return unsafeIsType<T, U>(fill, "fillAmount") ? fill.fillAmount : fill.outputAmount;
}

// Returns the cumulative amount filled for a unique fill hash.
export function getTotalFilledAmount<
  T extends Pick<V2Fill, "totalFilledAmount">,
  U extends Pick<V3Fill, "outputAmount">,
>(fill: T | U): BN {
  return unsafeIsType<T, U>(fill, "totalFilledAmount") ? fill.totalFilledAmount : fill.outputAmount;
}

export function getRelayDataOutputToken<
  T extends Pick<V2RelayData, "destinationToken">,
  U extends Pick<V3RelayData, "outputToken">,
>(relayData: T | U): string {
  return isV2RelayData(relayData) ? relayData.destinationToken : relayData.outputToken;
}

export function getRelayDataOutputAmount<
  T extends Pick<V2RelayData, "amount">,
  U extends Pick<V3RelayData, "outputAmount">,
>(relayData: T | U): BN {
  return unsafeIsType<T, U>(relayData, "amount") ? relayData.amount : relayData.outputAmount;
}

export function getSlowFillLeafChainId<
  T extends { relayData: { destinationChainId: V2SlowFillLeaf["relayData"]["destinationChainId"] } },
  U extends Pick<V3SlowFillLeaf, "chainId">,
>(leaf: T | U): number {
  return unsafeIsType<U, T>(leaf, "chainId") ? leaf.chainId : leaf.relayData.destinationChainId;
}

export function getSlowFillLeafLpFeePct<
  T extends { relayData: { realizedLpFeePct: V2SlowFillLeaf["relayData"]["realizedLpFeePct"] } },
  U extends Pick<V3SlowFillLeaf, "updatedOutputAmount" | "relayData">,
>(leaf: T | U): BN {
  return unsafeIsType<U, T>(leaf, "updatedOutputAmount")
    ? leaf.relayData.inputAmount.sub(leaf.updatedOutputAmount).mul(fixedPointAdjustment).div(leaf.relayData.inputAmount)
    : leaf.relayData.realizedLpFeePct;
}
