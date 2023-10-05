import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../constants";
import { Deposit, Fill } from "../interfaces";
import { bnZero } from "./BigNumberUtils";

export function buildFillForSimulatingFullDeposit(
  deposit: Deposit,
  relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS
): Fill {
  return {
    amount: deposit.amount,
    fillAmount: deposit.amount, // We're simulating a full fill
    depositId: deposit.depositId,
    destinationChainId: deposit.destinationChainId,
    originChainId: deposit.originChainId,
    totalFilledAmount: deposit.amount,
    // We can set this to the destinationChainId since we are simulating a
    // full fill and we don't care
    repaymentChainId: deposit.destinationChainId,
    destinationToken: deposit.destinationToken,
    relayer: relayerAddress,
    depositor: deposit.depositor,
    message: deposit.message,
    recipient: deposit.recipient,
    relayerFeePct: deposit.relayerFeePct,
    // We can do our best to accurately set the LP fee pct, but it's not
    // required for the simulation
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    updatableRelayData: {
      isSlowRelay: false,
      message: deposit.message,
      payoutAdjustmentPct: bnZero,
      recipient: deposit.recipient,
      relayerFeePct: deposit.relayerFeePct,
    },
  };
}
