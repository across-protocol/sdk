import _ from "lodash";
import assert from "assert";
import { providers } from "ethers";
import { DepositWithBlock, Fill, FillWithBlock } from "../../../interfaces";
import { isSlowFill, isValidEvmAddress, isDefined, chainIsEvm } from "../../../utils";
import { HubPoolClient } from "../../HubPoolClient";

/**
 * @notice FillRepaymentInformation is a fill with additional properties required to determine where it can
 * be repaid.
 */
type FillRepaymentInformation = Fill & { quoteBlockNumber: number; fromLiteChain: boolean };

/**
 * @notice Return repayment chain and repayment token for a fill, but does not verify if the returned
 * repayment information is valid for the desired repayment address.
 * @dev The passed in fill should be verified first via verifyFillRepayment(), otherwise this function
 * will throw.
 * @param fill The fill to get the repayment information for. If this fill cannot be repaid then this
 * function will throw.
 * @return The chain to send the refund to and the token to use for the refund.
 */
export function getRefundInformationFromFill(
  relayData: FillRepaymentInformation,
  hubPoolClient: HubPoolClient
): {
  chainToSendRefundTo: number;
  repaymentToken: string;
} {
  assert(
    !_repaymentAddressNeedsToBeOverwritten(relayData),
    "getRefundInformationFromFill: fill repayment address must be overwritten"
  );
  const chainToSendRefundTo = _getRepaymentChainId(relayData, hubPoolClient);
  if (chainToSendRefundTo === relayData.originChainId) {
    return {
      chainToSendRefundTo,
      repaymentToken: relayData.inputToken,
    };
  }

  // Now figure out the equivalent L2 token for the repayment token. If the inputToken doesn't have a
  // PoolRebalanceRoute, then the repayment chain would have been the originChainId after the getRepaymentChainId()
  // call and we would have returned already, so the following call should always succeed.
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    relayData.inputToken,
    relayData.originChainId,
    relayData.quoteBlockNumber
  );

  const repaymentToken = hubPoolClient.getL2TokenForL1TokenAtBlock(
    l1TokenCounterpart,
    chainToSendRefundTo,
    relayData.quoteBlockNumber
  );
  return {
    chainToSendRefundTo,
    repaymentToken,
  };
}
/**
 * @notice Verifies that the fill can be repaid. If the repayment address is not
 * valid for the requested repayment chain, then this function will attempt to change the fill's repayment chain
 * to the destination chain and its repayment address to the  msg.sender and if this is possible,
 * return the fill. Otherwise, return undefined.
 * @param _fill Fill with a requested repayment chain and address
 * @return Fill with the applied repayment chain (depends on the validity of the requested repayment address)
 * and applied repayment address, or undefined if the applied repayment address is not valid for the
 * applied repayment chain.
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

  let repaymentChainId = _getRepaymentChainId(fill, hubPoolClient);

  // Repayments will always go to the fill.relayer address so check if its a valid EVM address. If its not, attempt
  // to change it to the msg.sender of the FilledRelay.
  if (_repaymentAddressNeedsToBeOverwritten(fill)) {
    // TODO: Handle case where fill was sent on non-EVM chain, in which case the following call would fail
    // or return something unexpected. We'd want to return undefined here.

    // @todo: If chainIsEvm:
    const fillTransaction = await destinationChainProvider.getTransaction(fill.transactionHash);
    const destinationRelayer = fillTransaction?.from;
    // Repayment chain is still an EVM chain, but the msg.sender is a bytes32 address, so the fill is invalid.
    if (!isDefined(destinationRelayer) || !isValidEvmAddress(destinationRelayer)) {
      return undefined;
    }
    // If we can switch the repayment chain to the destination chain, then do so. We should only switch if the
    // destination chain has a valid repayment token that is equivalent to the deposited input token. This would
    // also be the same mapping as the repayment token on the repayment chain.
    if (
      !matchedDeposit.fromLiteChain &&
      hubPoolClient.areTokensEquivalent(fill.inputToken, fill.originChainId, fill.outputToken, fill.destinationChainId)
    ) {
      repaymentChainId = fill.destinationChainId;
    }
    // If we can't switch the chain, then we need to verify that the msg.sender is a valid address on the repayment chain.
    // Because we already checked that the `destinationRelayer` was a valid EVM address above, we only need to check
    // that the repayment chain is an EVM chain.
    else {
      if (!chainIsEvm(repaymentChainId)) {
        return undefined;
      }
    }
    fill.relayer = destinationRelayer;

    // @todo: If chainIsSvm:
  }

  // Repayment address is now valid and repayment chain is either origin chain for lite chain or the destination
  // chain for cases where the repayment address was invalid. Fill should be valid now.
  fill.repaymentChainId = repaymentChainId;
  return fill;
}

function _getRepaymentChainId(relayData: FillRepaymentInformation, hubPoolClient: HubPoolClient): number {
  if (relayData.fromLiteChain) {
    assert(!isSlowFill(relayData), "getRepaymentChainId: fromLiteChain and slow fill are mutually exclusive");
    return relayData.originChainId;
  }

  // Handle slow relay where FilledRelay.repaymentChainId = 0, as hardcoded in the SpokePool contract.
  // Slow relays always pay recipient on destination chain.
  if (isSlowFill(relayData)) {
    return relayData.destinationChainId;
  }

  // Repayment chain is valid if the input token and repayment chain are mapped to the same PoolRebalanceRoute.
  const repaymentTokenIsValid = _repaymentChainTokenIsValid(relayData, hubPoolClient);
  if (repaymentTokenIsValid) {
    return relayData.repaymentChainId;
  }

  // If repayment chain is not valid, default to origin chain since we always know the input token can be refunded.
  return relayData.originChainId;
}

function _repaymentChainTokenIsValid(relayData: FillRepaymentInformation, hubPoolClient: HubPoolClient): boolean {
  if (
    !hubPoolClient.l2TokenHasPoolRebalanceRoute(
      relayData.inputToken,
      relayData.originChainId,
      relayData.quoteBlockNumber
    )
  ) {
    return false;
  }
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    relayData.inputToken,
    relayData.originChainId,
    relayData.quoteBlockNumber
  );
  if (
    !hubPoolClient.l2TokenEnabledForL1TokenAtBlock(
      l1TokenCounterpart,
      relayData.repaymentChainId,
      relayData.quoteBlockNumber
    )
  ) {
    return false;
  }
  return true;
}

function _repaymentAddressNeedsToBeOverwritten(fill: Fill): boolean {
  // Slow fills don't result in repayments so they're always valid.
  if (isSlowFill(fill)) {
    return false;
  }

  // @todo add Solana logic here:
  // - i.e. If chainIsSvm && !isValidSvmAddress(fill.relayer) then return false
  //        If chainIsEvm && !isValidEvmAddress(fill.relayer) then return false
  //        If chainIsEvm && isValidEvmAddress(fill.relayer) then return true
  return !isValidEvmAddress(fill.relayer);
}
