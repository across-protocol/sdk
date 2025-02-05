import _ from "lodash";
import { providers } from "ethers";
import { Deposit, DepositWithBlock, Fill, FillWithBlock } from "../../../interfaces";
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

export function getRepaymentChainId(fill: Fill, matchedDeposit: Deposit): number {
  // Lite chain deposits force repayment on origin chain.
  return matchedDeposit.fromLiteChain ? fill.originChainId : fill.repaymentChainId;
}

export function isEvmRepaymentValid(fill: Fill, repaymentChainId: number): boolean {
  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return true;
  }
  return chainIsEvm(repaymentChainId) && isValidEvmAddress(fill.relayer);
}

// Verify that a fill sent to an EVM chain has a 20 byte address. If the fill does not, then attempt
// to repay the `msg.sender` of the relay transaction. Otherwise, return undefined.
export async function verifyFillRepayment(
  _fill: FillWithBlock,
  destinationChainProvider: providers.Provider,
  matchedDeposit: DepositWithBlock,
  hubPoolClient: HubPoolClient
): Promise<FillWithBlock | undefined> {
  const fill = _.cloneDeep(_fill);

  let repaymentChainId = getRepaymentChainId(fill, matchedDeposit);

  // If repayment chain doesn't have a Pool Rebalance Route for the input token, then change the repayment
  // chain to the destination chain.
  if (!isSlowFill(fill)) {
    try {
      const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
        fill.inputToken,
        fill.originChainId,
        matchedDeposit.quoteBlockNumber
      );
      hubPoolClient.getL2TokenForL1TokenAtBlock(l1TokenCounterpart, repaymentChainId, matchedDeposit.quoteBlockNumber);
      // Repayment token could be found, this is a valid repayment chain.
    } catch {
      // Repayment token doesn't exist on repayment chain via PoolRebalanceRoutes, impossible to repay filler there.
      repaymentChainId = fill.destinationChainId;
    }
  }
  const validEvmRepayment = isEvmRepaymentValid(fill, repaymentChainId);

  // Case 1: Repayment chain is EVM and repayment address is valid EVM address.
  if (validEvmRepayment) {
    return fill;
  }
  // Case 2: Repayment chain is not EVM or address is not a valid EVM address. Attempt to switch repayment
  // address to msg.sender of relay transaction and repayment chain to destination chain.
  else {
    if (!chainIsEvm(repaymentChainId)) {
      const newRepaymentChain = matchedDeposit.fromLiteChain ? fill.originChainId : fill.destinationChainId;
      fill.repaymentChainId = newRepaymentChain;
    }

    if (!isValidEvmAddress(fill.relayer)) {
      // TODO: Handle case where fill was sent on non-EVM chain, in which case the following call would fail
      // or return something unexpected. We'd want to return undefined here.
      const fillTransaction = await destinationChainProvider.getTransaction(fill.transactionHash);
      const destinationRelayer = fillTransaction?.from;
      // Repayment chain is still an EVM chain, but the msg.sender is a bytes32 address, so the fill is invalid.
      if (!isDefined(destinationRelayer) || !isValidEvmAddress(destinationRelayer)) {
        return undefined;
      }
      fill.relayer = destinationRelayer;
    }

    return fill;
  }
}
