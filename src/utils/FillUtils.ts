import { BigNumberish } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS, EMPTY_MESSAGE } from "../constants";
import { Fill } from "../interfaces";
import { bnZero, toBN } from "./BigNumberUtils";
import { resolveContractFromSymbol } from "./TokenUtils";
import { isDefined } from "./TypeGuards";
import { randomAddress } from "./common";

export function buildFillForSimulatingFullDeposit(
  amountToRelay: BigNumberish,
  tokenSymbol: string,
  originChainId: number,
  destinationChainId: number,
  recipientAddress: string,
  message: string = EMPTY_MESSAGE,
  depositorAddress = randomAddress(),
  relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS
): Fill {
  const destinationToken = resolveContractFromSymbol(tokenSymbol, String(destinationChainId));
  if (!isDefined(destinationToken)) {
    throw new Error(`Could not resolve token contract for ${tokenSymbol} on ${destinationChainId}`);
  }
  const amount = toBN(amountToRelay);
  return {
    amount,
    fillAmount: amount, // We're simulating a full fill
    depositId: 0, // We want to avoid a direct depositId collision
    destinationChainId,
    originChainId,
    destinationToken: destinationToken,
    totalFilledAmount: amount,
    // We can set this to the destinationChainId since we are simulating a
    // full fill and we don't care
    repaymentChainId: destinationChainId,
    relayer: relayerAddress,
    depositor: depositorAddress,
    message: message,
    recipient: recipientAddress,
    relayerFeePct: bnZero,
    realizedLpFeePct: bnZero,
    updatableRelayData: {
      isSlowRelay: false,
      message: message,
      payoutAdjustmentPct: bnZero,
      recipient: recipientAddress,
      relayerFeePct: bnZero,
    },
  };
}
