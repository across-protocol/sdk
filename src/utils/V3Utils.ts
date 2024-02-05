import {
  Deposit,
  Fill,
  FillType,
  RelayData,
  SlowFillLeaf,
  SpeedUp,
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
import { isDefined } from "./TypeGuards";

// Lowest ConfigStore version where the V3 model is in effect. The version update to the following value should
// take place atomically with the SpokePool upgrade to V3 so that the dataworker knows what kind of MerkleLeaves
// to propose in root bundles (i.e. RelayerRefundLeaf and SlowFillLeaf have different shapes). We assume that
// V3 will be deployed in between bundles (after a bundle execution and before a proposal). The dataworker/relayer
// code can use the following isV3() function to separate logic for calling V3 vs. legacy methods.
export const V3_MIN_CONFIG_STORE_VERSION = 3;

export function isV3(version: number): boolean {
  return version >= V3_MIN_CONFIG_STORE_VERSION;
}

export function isV2Deposit(deposit: Deposit): deposit is V2Deposit {
  return isDefined((deposit as V2Deposit).originToken);
}

export function isV3Deposit(deposit: Deposit): deposit is V3Deposit {
  return isDefined((deposit as V3Deposit).inputToken);
}

export function isV2SpeedUp(speedUp: SpeedUp): speedUp is V2SpeedUp {
  return isDefined((speedUp as V2SpeedUp).newRelayerFeePct);
}

export function isV3SpeedUp(speedUp: SpeedUp): speedUp is V3SpeedUp {
  return isDefined((speedUp as V3SpeedUp).updatedOutputAmount);
}

export function isV2Fill(fill: Fill): fill is V2Fill {
  return isDefined((fill as V2Fill).destinationToken);
}

export function isV3Fill(fill: Fill): fill is V3Fill {
  return isDefined((fill as V3Fill).inputToken);
}

export function isV2RelayData(relayData: RelayData): relayData is V2RelayData {
  return isDefined((relayData as V2RelayData).destinationToken);
}

export function isV3RelayData(relayData: RelayData): relayData is V3RelayData {
  return isDefined((relayData as V3RelayData).outputToken);
}

export function isSlowFill(fill: Fill): boolean {
  return isV2Fill(fill) ? fill.updatableRelayData.isSlowRelay : fill.updatableRelayData.fillType === FillType.SlowFill;
}

export function isV2SlowFillLeaf(slowFillLeaf: SlowFillLeaf): slowFillLeaf is V2SlowFillLeaf {
  return isDefined((slowFillLeaf as V2SlowFillLeaf).payoutAdjustmentPct) && isV2RelayData(slowFillLeaf.relayData);
}

export function isV3SlowFillLeaf(slowFillLeaf: SlowFillLeaf): slowFillLeaf is V3SlowFillLeaf {
  return isDefined((slowFillLeaf as V3SlowFillLeaf).updatedOutputAmount) && isV3RelayData(slowFillLeaf.relayData);
}

export function getDepositInputToken(deposit: Deposit): string {
  return isV2Deposit(deposit) ? deposit.originToken : deposit.inputToken;
}

export function getDepositOutputToken(deposit: Deposit): string {
  return isV2Deposit(deposit) ? deposit.destinationToken : deposit.outputToken;
}

export function getFillOutputToken(fill: Fill): string {
  return isV2Fill(fill) ? fill.destinationToken : fill.outputToken;
}

export function getDepositInputAmount(deposit: Deposit): BN {
  return isV2Deposit(deposit) ? deposit.amount : deposit.inputAmount;
}

export function getDepositOutputAmount(deposit: Deposit): BN {
  return isV2Deposit(deposit) ? deposit.amount : deposit.outputAmount;
}

// Returns the total output amount for a unique fill hash.
export function getFillOutputAmount(fill: Fill): BN {
  return isV2Fill(fill) ? fill.amount : fill.outputAmount;
}

// Returns the amount filled by a particular fill event.
export function getFillAmount(fill: Fill): BN {
  return isV2Fill(fill) ? fill.fillAmount : fill.outputAmount;
}

// Returns the cumulative amount filled for a unique fill hash.
export function getTotalFilledAmount(fill: Fill): BN {
  return isV2Fill(fill) ? fill.totalFilledAmount : fill.outputAmount;
}

export function getRelayDataOutputToken(relayData: RelayData): string {
  return isV2RelayData(relayData) ? relayData.destinationToken : relayData.outputToken;
}

export function getRelayDataOutputAmount(relayData: RelayData): BN {
  return isV2RelayData(relayData) ? relayData.amount : relayData.outputAmount;
}

export function getSlowFillLeafChainId(leaf: SlowFillLeaf): number {
  return isV2SlowFillLeaf(leaf) ? leaf.relayData.destinationChainId : leaf.chainId;
}
