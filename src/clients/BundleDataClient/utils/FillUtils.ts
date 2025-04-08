import _ from "lodash";
import { providers } from "ethers";
import { Deposit, DepositWithBlock, Fill, FillWithBlock } from "../../../interfaces";
import { getBlockRangeForChain, isSlowFill, isValidEvmAddress, isDefined, chainIsEvm } from "../../../utils";
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
  // If the input token and origin chain ID do not map to a PoolRebalanceRoute graph, then repayment must
  // happen on the origin chain.
  if (!hubPoolClient.l2TokenHasPoolRebalanceRoute(fill.inputToken, fill.originChainId)) {
    return {
      chainToSendRefundTo: fill.originChainId,
      repaymentToken: fill.inputToken,
    };
  }

  // Handle slow relay where repaymentChainId = 0. Slow relays always pay recipient on destination chain.
  // So, save the slow fill under the destination chain, and save the fast fill under its repayment chain.
  let chainToSendRefundTo = isSlowFill(fill) ? fill.destinationChainId : fill.repaymentChainId;
  // If the fill is for a deposit originating from the lite chain, the repayment chain is the origin chain
  // regardless of whether it is a slow or fast fill (we ignore slow fills but this is for posterity).
  // @note fill.repaymentChainId should already be set to originChainId but reset it to be safe.
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

export function getRepaymentChainId(fill: Fill, matchedDeposit: Deposit, hubPoolClient: HubPoolClient): number {
  // Lite chain deposits force repayment on origin chain.
  if (matchedDeposit.fromLiteChain) {
    return matchedDeposit.originChainId;
  }
  if (!hubPoolClient.l2TokenHasPoolRebalanceRoute(matchedDeposit.inputToken, matchedDeposit.originChainId)) {
    return matchedDeposit.originChainId;
  }
  return fill.repaymentChainId;
}

export function forceDestinationRepayment(
  repaymentChainId: number,
  matchedDeposit: Deposit & { quoteBlockNumber: number },
  hubPoolClient: HubPoolClient
): boolean {
  if (
    !matchedDeposit.fromLiteChain &&
    hubPoolClient.l2TokenHasPoolRebalanceRoute(matchedDeposit.inputToken, matchedDeposit.originChainId)
  ) {
    try {
      const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
        matchedDeposit.inputToken,
        matchedDeposit.originChainId,
        matchedDeposit.quoteBlockNumber
      );
      hubPoolClient.getL2TokenForL1TokenAtBlock(l1TokenCounterpart, repaymentChainId, matchedDeposit.quoteBlockNumber);
      // Repayment token could be found, this is a valid repayment chain.
      return false;
    } catch {
      // Repayment token doesn't exist on repayment chain via PoolRebalanceRoutes, impossible to repay filler there.
      return true;
    }
  } else {
    return false;
  }
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

  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return fill;
  }

  let repaymentChainId = getRepaymentChainId(fill, matchedDeposit, hubPoolClient);

  // If repayment chain doesn't have a Pool Rebalance Route for the input token, then change the repayment
  // chain to the destination chain.
  if (forceDestinationRepayment(repaymentChainId, matchedDeposit, hubPoolClient)) {
    repaymentChainId = fill.destinationChainId;
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
    if (
      !matchedDeposit.fromLiteChain &&
      hubPoolClient.l2TokenHasPoolRebalanceRoute(matchedDeposit.inputToken, matchedDeposit.originChainId)
    ) {
      repaymentChainId = fill.destinationChainId;
    } else {
      // We can't switch repayment chain for a lite chain deposit so just check whether the repayment chain,
      // which should be the origin chain, is an EVM chain.
      if (!chainIsEvm(repaymentChainId)) {
        return undefined;
      }
    }
    fill.relayer = destinationRelayer;
  }

  // Repayment address is now valid and repayment chain is either origin chain for lite chain or the destination
  // chain for cases where the repayment address was invalid. Fill should be valid now.
  fill.repaymentChainId = repaymentChainId;
  return fill;
}
