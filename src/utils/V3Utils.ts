import {
  FillType,
  v2Deposit,
  v3Deposit,
  v2Fill,
  v2RelayData,
  v2SpeedUp,
  v3Fill,
  v3RelayData,
  v3SpeedUp,
} from "../interfaces";
import { BN } from "./BigNumberUtils";
import { isDefined } from "./TypeGuards";

type Deposit = v2Deposit | v3Deposit;
type Fill = v2Fill | v3Fill;
type SpeedUp = v2SpeedUp | v3SpeedUp;
type RelayData = v2RelayData | v3RelayData;

export function isV2Deposit(deposit: Deposit): deposit is v2Deposit {
  return isDefined((deposit as v2Deposit).originToken);
}

export function isV2SpeedUp(speedUp: SpeedUp): speedUp is v2SpeedUp {
  return isDefined((speedUp as v2SpeedUp).newRelayerFeePct);
}

export function isV3Deposit(deposit: Deposit): deposit is v3Deposit {
  return isDefined((deposit as v3Deposit).inputToken);
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

export function isV2RelayData(relayData: RelayData): relayData is v2RelayData {
  return isDefined((relayData as v2RelayData).destinationToken);
}

export function isSlowFill(fill: Fill): boolean {
  return isV2Fill(fill) ? fill.updatableRelayData.isSlowRelay : fill.updatableRelayData.fillType === FillType.SlowFill;
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
