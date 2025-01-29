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
  validChainIds: number[]
): Promise<FillWithBlock | undefined> {
  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return fill;
  }
  // Lite chain deposits force repayment on origin chain.
  const repaymentChainId = matchedDeposit.fromLiteChain ? fill.originChainId : fill.repaymentChainId;
  // Return undefined if the requested repayment chain ID is not recognized by the hub pool.
  if (!validChainIds.includes(repaymentChainId)) {
    return undefined;
  }
  const updatedFill = _.cloneDeep(fill);
  // If the fill requests repayment on an unsupported chain, return false. Lite chain validation happens in
  // `getRefundInformationFromFill`.
  if (chainIsEvm(repaymentChainId) && !isValidEvmAddress(updatedFill.relayer)) {
    // If the fill was from a lite chain, the origin chain is an EVM chain, and the relayer address is invalid
    // for EVM chains, then we cannot refund the relayer, so mark the fill as invalid.
    if (matchedDeposit.fromLiteChain) {
      return undefined;
    }
    const fillTransaction = await destinationChainProvider.getTransaction(updatedFill.transactionHash);
    const destinationRelayer = fillTransaction?.from;
    // Repayment chain is still an EVM chain, but the msg.sender is a bytes32 address, so the fill is invalid.
    if (!isDefined(destinationRelayer) || !isValidEvmAddress(destinationRelayer)) {
      return undefined;
    }
    // Otherwise, assume the relayer to be repaid is the msg.sender.
    updatedFill.relayer = destinationRelayer;
  }
  return updatedFill;
}
