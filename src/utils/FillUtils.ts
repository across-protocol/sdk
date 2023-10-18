import { BigNumberish } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS, EMPTY_MESSAGE } from "../constants";
import { Deposit, Fill } from "../interfaces";
import { bnUint32Max, bnZero, toBN } from "./BigNumberUtils";

export function buildFillForSimulatingFullDeposit(
  deposit: Deposit,
  amountToRelay: BigNumberish,
  relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS
): Fill {
  const amount = toBN(amountToRelay);
  return {
    amount,
    fillAmount: amount, // We're simulating a full fill
    depositId: bnUint32Max.toNumber(), // We want to avoid a direct depositId collision
    destinationChainId: deposit.destinationChainId,
    originChainId: deposit.originChainId,
    destinationToken: deposit.destinationToken,
    totalFilledAmount: amount,
    // We can set this to the destinationChainId since we are simulating a
    // full fill and we don't care
    repaymentChainId: deposit.destinationChainId,
    relayer: relayerAddress,
    depositor: deposit.depositor,
    message: deposit.message,
    recipient: deposit.recipient,
    relayerFeePct: bnZero,
    realizedLpFeePct: bnZero,
    updatableRelayData: {
      isSlowRelay: false,
      message: deposit.updatedMessage ?? EMPTY_MESSAGE,
      payoutAdjustmentPct: bnZero,
      recipient: deposit.recipient,
      relayerFeePct: bnZero,
    },
  };
}
