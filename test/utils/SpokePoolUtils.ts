import { DepositWithBlock, Fill, V2DepositWithBlock, V2Fill } from "../../src/interfaces";
import { bnZero, isV2Deposit } from "../../src/utils";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  return isV2Deposit(deposit) ? v2FillFromDeposit(deposit, relayer) : v3FillFromDeposit(deposit, relayer);
}

export function v2FillFromDeposit(deposit: V2DepositWithBlock, relayer: string): V2Fill {
  const { recipient, message, relayerFeePct } = deposit;

  const fill: Fill = {
    amount: deposit.amount,
    depositId: deposit.depositId,
    originChainId: deposit.originChainId,
    destinationChainId: deposit.destinationChainId,
    depositor: deposit.depositor,
    destinationToken: deposit.destinationToken,
    relayerFeePct: deposit.relayerFeePct,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    recipient,
    relayer,
    message,

    // Caller can modify these later.
    fillAmount: deposit.amount,
    totalFilledAmount: deposit.amount,
    repaymentChainId: deposit.destinationChainId,

    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      relayerFeePct: deposit.newRelayerFeePct ?? relayerFeePct,
      isSlowRelay: false,
      payoutAdjustmentPct: bnZero,
    },
  };

  return fill;
}
