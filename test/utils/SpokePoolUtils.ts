import { DepositWithBlock, Fill, FillType } from "../../src/interfaces";
import { getMessageHash } from "../../src/utils";

export function fillFromDeposit(
  deposit: DepositWithBlock,
  relayer: string
): Omit<Fill, "messageHash"> & { message: string } {
  const { blockNumber, transactionHash, transactionIndex, ...partialDeposit } = deposit;
  const { recipient, message } = partialDeposit;

  const updatedMessage = deposit.updatedMessage ?? message;
  const fill = {
    ...partialDeposit,
    relayer,
    message,
    // Caller can modify these later.
    exclusiveRelayer: relayer,
    repaymentChainId: deposit.destinationChainId,
    relayExecutionInfo: {
      updatedRecipient: deposit.updatedRecipient ?? recipient,
      updatedMessage,
      updatedMessageHash: getMessageHash(updatedMessage),
      updatedOutputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}
