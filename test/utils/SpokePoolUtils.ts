import {
  DepositWithBlock,
  Fill,
  FillType,
  v2DepositWithBlock,
  v2Fill,
  v3DepositWithBlock,
  v3Fill,
} from "../../src/interfaces";
import { bnZero, isV2Deposit } from "../../src/utils";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  return isV2Deposit(deposit) ? v2FillFromDeposit(deposit, relayer) : v3FillFromDeposit(deposit, relayer);
}

export function v2FillFromDeposit(deposit: v2DepositWithBlock, relayer: string): v2Fill {
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

export function v3FillFromDeposit(deposit: v3DepositWithBlock, relayer: string): v3Fill {
  const { blockNumber, transactionHash, transactionIndex, ...partialDeposit } = deposit;
  const { recipient, message } = partialDeposit;

  const fill: v3Fill = {
    ...partialDeposit,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    relayer,

    // Caller can modify these later.
    exclusiveRelayer: relayer,
    repaymentChainId: deposit.destinationChainId,
    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      outputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}
