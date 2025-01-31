import { DepositWithBlock, Fill, FillType } from "../../src/interfaces";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  const { blockNumber, transactionHash, transactionIndex, ...partialDeposit } = deposit;
  const { recipient, message } = partialDeposit;

  const fill = {
    ...partialDeposit,
    relayer,

    // Caller can modify these later.
    exclusiveRelayer: relayer,
    repaymentChainId: deposit.destinationChainId,
    relayExecutionInfo: {
      updatedRecipient: deposit.updatedRecipient ?? recipient,
      updatedMessage: deposit.updatedMessage ?? message,
      updatedOutputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}
