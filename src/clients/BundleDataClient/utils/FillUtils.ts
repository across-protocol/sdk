import _ from "lodash";
import { providers } from "ethers";
import { DepositWithBlock, Fill, FillWithBlock } from "../../../interfaces";
import { getBlockRangeForChain, isSlowFill, chainIsEvm, isValidEvmAddress, isDefined } from "../../../utils";
import { HubPoolClient } from "../../HubPoolClient";

export function getRefundInformationFromFill(
  fill: Fill,
  hubPoolClient: HubPoolClient,
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  fromLiteChain: boolean
): {
  chainToSendRefundTo: number;
  repaymentToken: string;
} {
  // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
  // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
  let chainToSendRefundTo = isSlowFill(fill) ? fill.destinationChainId : fill.repaymentChainId;
  // If the fill is for a deposit originating from the lite chain, the repayment chain is the origin chain
  // regardless of whether it is a slow or fast fill (we ignore slow fills but this is for posterity).
  if (fromLiteChain) {
    chainToSendRefundTo = fill.originChainId;
  }

  // Save fill data and associate with repayment chain and L2 token refund should be denominated in.
  const endBlockForMainnet = getBlockRangeForChain(
    blockRangesForChains,
    hubPoolClient.chainId,
    chainIdListForBundleEvaluationBlockNumbers
  )[1];

  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    fill.inputToken,
    fill.originChainId,
    endBlockForMainnet
  );

  const repaymentToken = hubPoolClient.getL2TokenForL1TokenAtBlock(
    l1TokenCounterpart,
    chainToSendRefundTo,
    endBlockForMainnet
  );
  return {
    chainToSendRefundTo,
    repaymentToken,
  };
}

// Verify that a fill sent to an EVM chain has a 20 byte address. If the fill does not, then attempt
// to repay the `msg.sender` of the relay transaction. Otherwise, return undefined.
export async function verifyFillRepayment(
  fill: FillWithBlock,
  destinationChainProvider: providers.Provider,
  matchedDeposit: DepositWithBlock,
  possibleRepaymentChainIds: number[]
): Promise<FillWithBlock | undefined> {
  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return fill;
  }
  // Lite chain deposits force repayment on origin chain.
  const repaymentChainId = matchedDeposit.fromLiteChain ? fill.originChainId : fill.repaymentChainId;
  // Return undefined if the requested repayment chain ID is not recognized by the hub pool.
  if (!possibleRepaymentChainIds.includes(repaymentChainId)) {
    return undefined;
  }
  const updatedFill = _.cloneDeep(fill);

  // If the fill requests repayment on a chain where the repayment address is not valid, attempt to find a valid
  // repayment address, otherwise return undefined.

  // Case 1: repayment chain is an EVM chain but repayment address is not a valid EVM address.
  if (chainIsEvm(repaymentChainId) && !isValidEvmAddress(updatedFill.relayer)) {
    // TODO: Handle case where fill was sent on non-EVM chain, in which case the following call would fail
    // or return something unexpected. We'd want to return undefined here.
    const fillTransaction = await destinationChainProvider.getTransaction(updatedFill.transactionHash);
    const destinationRelayer = fillTransaction?.from;
    // Repayment chain is still an EVM chain, but the msg.sender is a bytes32 address, so the fill is invalid.
    if (!isDefined(destinationRelayer) || !isValidEvmAddress(destinationRelayer)) {
      return undefined;
    }
    // Otherwise, assume the relayer to be repaid is the msg.sender. We don't need to modify the repayment chain since
    // the getTransaction() call would only succeed if the fill was sent on an EVM chain and therefore the msg.sender
    // is a valid EVM address and the repayment chain is an EVM chain.
    updatedFill.relayer = destinationRelayer;
  }

  // Case 2: TODO repayment chain is an SVM chain and repayment address is not a valid SVM address.
  return updatedFill;
}
