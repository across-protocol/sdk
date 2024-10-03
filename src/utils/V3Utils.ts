import { Fill, FillType, SlowFillLeaf } from "../interfaces";
import { BN } from "./BigNumberUtils";
import { fixedPointAdjustment } from "./common";

export function isSlowFill(fill: Fill): boolean {
  return fill.relayExecutionInfo.fillType === FillType.SlowFill;
}

export function getSlowFillLeafLpFeePct(leaf: SlowFillLeaf): BN {
  const { relayData, updatedOutputAmount } = leaf;
  return relayData.inputAmount.sub(updatedOutputAmount).mul(fixedPointAdjustment).div(relayData.inputAmount);
}
