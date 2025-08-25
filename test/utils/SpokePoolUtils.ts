import { DepositWithBlock, RelayData, FillType } from "../../src/interfaces";
import { Address, getMessageHash } from "../../src/utils";

export function fillFromDeposit(
  deposit: DepositWithBlock,
  relayer: Address
): RelayData & { destinationChainId: number } {
  const { blockNumber, txnRef, txnIndex, ...partialDeposit } = deposit;
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
      updatedRecipient: deposit.updatedRecipient?.toBytes32() ?? recipient,
      updatedMessage,
      updatedMessageHash: getMessageHash(updatedMessage),
      updatedOutputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}
