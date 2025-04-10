import _ from "lodash";
import assert from "assert";
import { providers } from "ethers";
import { DepositWithBlock, Fill, FillWithBlock } from "../../../interfaces";
import { getBlockRangeForChain, isSlowFill, isValidEvmAddress, isDefined, chainIsEvm } from "../../../utils";
import { HubPoolClient } from "../../HubPoolClient";

/**
 * @notice Return repayment chain and repayment token for a fill, but does not verify if the returned
 * repayment information is valid for the desired repayment address.
 * @dev The passed in fill ideally should be verified via verifyFillRepayment(), otherwise the returned
 * repayment chain might not be able to be used to repay this fill.relayer
 * @param fill The fill to get the repayment information for
 */
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
  assert(
    !_repaymentAddressNeedsToBeOverwritten(fill),
    "getRefundInformationFromFill: fill repayment address must be overwritten"
  );
  const endBlockForMainnet = getBlockRangeForChain(
    blockRangesForChains,
    hubPoolClient.chainId,
    chainIdListForBundleEvaluationBlockNumbers
  )[1];
  const depositRepaymentData = { ...fill, fromLiteChain, quoteBlockNumber: endBlockForMainnet };
  const chainToSendRefundTo = getRepaymentChainId(fill.repaymentChainId, depositRepaymentData, hubPoolClient);
  if (chainToSendRefundTo === fill.originChainId) {
    return {
      chainToSendRefundTo,
      repaymentToken: fill.inputToken,
    };
  }

  // Now figure out the equivalent L2 token for the repayment token. If the inputToken doesn't have a
  // PoolRebalanceRoute, then the repayment chain would have been the originChainId after the getRepaymentChainId()
  // call and we would have returned already, so the following call should always succeed.
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

type FillRepaymentInformation = Fill & { quoteBlockNumber: number; fromLiteChain: boolean };

export function _depositHasPoolRebalanceRoute(
  relayData: FillRepaymentInformation,
  hubPoolClient: HubPoolClient
): boolean {
  return (
    hubPoolClient.l2TokenHasPoolRebalanceRoute(
      relayData.inputToken,
      relayData.originChainId,
      relayData.quoteBlockNumber
    ) &&
    hubPoolClient.l2TokenHasPoolRebalanceRoute(
      relayData.outputToken,
      relayData.destinationChainId,
      relayData.quoteBlockNumber
    )
  );
}

function _forceOriginChainRepayment(relayData: FillRepaymentInformation, hubPoolClient: HubPoolClient): boolean {
  return relayData.fromLiteChain || !_depositHasPoolRebalanceRoute(relayData, hubPoolClient);
}

/**
 * @notice Returns repayment chain for the fill based on its input, output, and requested repayment
 * tokens and chains as well as its Lite chain and Slow Fill statuses
 */
export function getRepaymentChainId(
  repaymentChainId: number,
  relayData: FillRepaymentInformation,
  hubPoolClient: HubPoolClient
): number {
  // This will be true if the input or output tokens do not have valid PoolRebalanceRoute mappings or if the
  // deposit originated from a lite chain.
  if (_forceOriginChainRepayment(relayData, hubPoolClient)) {
    return relayData.originChainId;
  }

  // Handle slow relay where FilledRelay.repaymentChainId = 0, as hardcoded in the SpokePool contract.
  // Slow relays always pay recipient on destination chain.
  if (isSlowFill(relayData)) {
    return relayData.destinationChainId;
  }

  // If desired repayment chain isn't a valid chain for the PoolRebalanceRoute mapping of the input token,
  // then repayment must be overwritten to the destination chain.
  const repaymentTokenIsInvalid = _repaymentChainTokenIsInvalid(repaymentChainId, relayData, hubPoolClient);
  return repaymentTokenIsInvalid ? relayData.destinationChainId : repaymentChainId;
}

function _repaymentChainTokenIsInvalid(
  repaymentChainId: number,
  relayData: FillRepaymentInformation,
  hubPoolClient: HubPoolClient
): boolean {
  try {
    const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      relayData.inputToken,
      relayData.originChainId,
      relayData.quoteBlockNumber
    );
    hubPoolClient.getL2TokenForL1TokenAtBlock(l1TokenCounterpart, repaymentChainId, relayData.quoteBlockNumber);
    // Repayment token could be found, this is a valid repayment chain.
    return false;
  } catch {
    // Repayment token doesn't exist on repayment chain via PoolRebalanceRoutes, impossible to repay filler there.
    return true;
  }
}

function _repaymentAddressNeedsToBeOverwritten(fill: Fill): boolean {
  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return false;
  }

  return !isValidEvmAddress(fill.relayer);
}
/**
 * @notice Verifies that the fill is valid for the repayment address and chain. If the repayment address is not
 * valid for the computed repayment chain, then this function will attempt to change the fill's repayment chain
 * to the destination chain and its repayment address to the  msg.sender and if this is possible,
 * return the fill. Otherwise, return undefined.
 */
export async function verifyFillRepayment(
  _fill: FillWithBlock,
  destinationChainProvider: providers.Provider,
  matchedDeposit: DepositWithBlock,
  hubPoolClient: HubPoolClient
): Promise<FillWithBlock | undefined> {
  const fill = {
    ..._.cloneDeep(_fill),
    fromLiteChain: matchedDeposit.fromLiteChain,
    quoteBlockNumber: matchedDeposit.quoteBlockNumber,
  };

  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return fill;
  }

  let repaymentChainId = getRepaymentChainId(fill.repaymentChainId, fill, hubPoolClient);

  // Repayments will always go to the fill.relayer address so check if its a valid EVM address. If its not, attempt
  // to change it to the msg.sender of the FilledRelay.
  if (_repaymentAddressNeedsToBeOverwritten(fill)) {
    // TODO: Handle case where fill was sent on non-EVM chain, in which case the following call would fail
    // or return something unexpected. We'd want to return undefined here.
    const fillTransaction = await destinationChainProvider.getTransaction(fill.transactionHash);
    const destinationRelayer = fillTransaction?.from;
    // Repayment chain is still an EVM chain, but the msg.sender is a bytes32 address, so the fill is invalid.
    if (!isDefined(destinationRelayer) || !isValidEvmAddress(destinationRelayer)) {
      return undefined;
    }
    // If we can switch the repayment chain to the destination chain, then do so. Otherwise,
    // check whether the repayment chain is an EVM chain
    if (!_forceOriginChainRepayment(fill, hubPoolClient)) {
      repaymentChainId = fill.destinationChainId;
    } else {
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
