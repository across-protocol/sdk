import {
  FillType,
  v2Deposit,
  v3Deposit,
  v2Fill,
  v2RelayData,
  v2SlowFillLeaf,
  v2SpeedUp,
  v3Fill,
  v3RelayData,
  v3SlowFillLeaf,
  v3SpeedUp,
} from "../interfaces";
import { BN } from "./BigNumberUtils";
import { isDefined } from "./TypeGuards";

type Deposit = v2Deposit | v3Deposit;
type Fill = v2Fill | v3Fill;
type SpeedUp = v2SpeedUp | v3SpeedUp;
type RelayData = v2RelayData | v3RelayData;
type SlowFillLeaf = v2SlowFillLeaf | v3SlowFillLeaf;

// Lowest ConfigStore version where the V3 model is in effect. The version update to the following value should
// take place atomically with the SpokePool upgrade to V3 so that the dataworker knows what kind of MerkleLeaves
// to propose in root bundles (i.e. RelayerRefundLeaf and SlowFillLeaf have different shapes). We assume that
// V3 will be deployed in between bundles (after a bundle execution and before a proposal). The dataworker/relayer
// code can use the following isV3() function to separate logic for calling V3 vs. legacy methods.
export const V3_MIN_CONFIG_STORE_VERSION = 3;

export function isV3(version: number): boolean {
  return version >= 3;
}

export function isV2Deposit(deposit: Deposit): deposit is v2Deposit {
  return isDefined((deposit as v2Deposit).originToken);
}

export function isV3Deposit(deposit: Deposit): deposit is v3Deposit {
  return isDefined((deposit as v3Deposit).inputToken);
}

export function isV2SpeedUp(speedUp: SpeedUp): speedUp is v2SpeedUp {
  return isDefined((speedUp as v2SpeedUp).newRelayerFeePct);
}

export function isV3SpeedUp(speedUp: SpeedUp): speedUp is v3SpeedUp {
  return isDefined((speedUp as v3SpeedUp).updatedOutputAmount);
}

export function isV2Fill(fill: Fill): fill is v2Fill {
  return isDefined((fill as v2Fill).destinationToken);
}

export function isV3Fill(fill: Fill): fill is v3Fill {
  return isDefined((fill as v3Fill).inputToken);
}

export function isSlowFill(fill: Fill): boolean {
  return isV2Fill(fill) ? fill.updatableRelayData.isSlowRelay : fill.updatableRelayData.fillType === FillType.SlowFill;
}

export function isV2RelayData(relayData: RelayData): relayData is v2RelayData {
  return isDefined((relayData as v2RelayData).destinationToken);
}

export function isV3RelayData(relayData: RelayData): relayData is v3RelayData {
  return isDefined((relayData as v3RelayData).outputToken);
}

export function isV2SlowFillLeaf(slowFillLeaf: SlowFillLeaf): slowFillLeaf is v2SlowFillLeaf {
  return isDefined((slowFillLeaf as v2SlowFillLeaf).payoutAdjustmentPct) && isV2RelayData(slowFillLeaf.relayData);
}

export function isV3SlowFillLeaf(slowFillLeaf: SlowFillLeaf): slowFillLeaf is v3SlowFillLeaf {
  return isDefined((slowFillLeaf as v3SlowFillLeaf).updatedOutputAmount) && isV3RelayData(slowFillLeaf.relayData);
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

export function getFillOutputAmount(fill: Fill): BN {
  return isV2Fill(fill) ? fill.amount : fill.outputAmount;
}

export function getFillAmount(fill: Fill): BN {
  return isV2Fill(fill) ? fill.fillAmount : fill.outputAmount;
}

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