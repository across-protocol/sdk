// Create a combined `refunds` object containing refunds for V2 + V3 fills
import assert from "assert";
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleSlowFills,
  CombinedRefunds,
  ExpiredDepositsToRefundV3,
  PoolRebalanceLeaf,
  Refund,
  RunningBalances,
  SpokePoolClientsByChain,
} from "../../../interfaces";
import {
  bnZero,
  AnyObject,
  fixedPointAdjustment,
  count2DDictionaryValues,
  count3DDictionaryValues,
  toAddressType,
  getImpliedBundleBlockRanges,
  EvmAddress,
} from "../../../utils";
import {
  addLastRunningBalance,
  constructPoolRebalanceLeaves,
  PoolRebalanceRoot,
  updateRunningBalance,
  updateRunningBalanceForDeposit,
} from "./PoolRebalanceUtils";
import { AcrossConfigStoreClient } from "../../AcrossConfigStoreClient";
import { HubPoolClient } from "../../HubPoolClient";
import { BundleDataClient } from "../../BundleDataClient";
import { buildPoolRebalanceLeafTree } from "./MerkleTreeUtils";

// and expired deposits.
export function getRefundsFromBundle(
  bundleFillsV3: BundleFillsV3,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3
): CombinedRefunds {
  const combinedRefunds: {
    [repaymentChainId: string]: {
      [repaymentToken: string]: Refund;
    };
  } = {};
  Object.entries(bundleFillsV3).forEach(([repaymentChainId, fillsForChain]) => {
    combinedRefunds[repaymentChainId] ??= {};
    Object.entries(fillsForChain).forEach(([l2TokenAddress, { refunds }]) => {
      // refunds can be undefined if these fills were all slow fill executions.
      if (refunds === undefined) {
        return;
      }
      // @dev use shallow copy so that modifying combinedRefunds doesn't modify the original refunds object.
      const refundsShallowCopy = { ...refunds };
      if (combinedRefunds[repaymentChainId][l2TokenAddress] === undefined) {
        combinedRefunds[repaymentChainId][l2TokenAddress] = refundsShallowCopy;
      } else {
        // Each refunds object should have a unique refund address so we can add new ones to the
        // existing dictionary.
        combinedRefunds[repaymentChainId][l2TokenAddress] = {
          ...combinedRefunds[repaymentChainId][l2TokenAddress],
          ...refundsShallowCopy,
        };
      }
    });
  });
  Object.entries(expiredDepositsToRefundV3).forEach(([originChainId, depositsForChain]) => {
    combinedRefunds[originChainId] ??= {};
    Object.entries(depositsForChain).forEach(([l2TokenAddress, deposits]) => {
      deposits.forEach((deposit) => {
        if (combinedRefunds[originChainId][l2TokenAddress] === undefined) {
          combinedRefunds[originChainId][l2TokenAddress] = { [deposit.depositor.toBytes32()]: deposit.inputAmount };
        } else {
          const existingRefundAmount = combinedRefunds[originChainId][l2TokenAddress][deposit.depositor.toBytes32()];
          combinedRefunds[originChainId][l2TokenAddress][deposit.depositor.toBytes32()] = deposit.inputAmount.add(
            existingRefundAmount ?? bnZero
          );
        }
      });
    });
  });
  return combinedRefunds;
}

export function prettyPrintV3SpokePoolEvents(
  bundleDepositsV3: BundleDepositsV3,
  bundleFillsV3: BundleFillsV3,
  bundleSlowFillsV3: BundleSlowFills,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
  unexecutableSlowFills: BundleExcessSlowFills
): AnyObject {
  return {
    bundleDepositsV3: count2DDictionaryValues(bundleDepositsV3),
    bundleFillsV3: count3DDictionaryValues(bundleFillsV3, "fills"),
    bundleSlowFillsV3: count2DDictionaryValues(bundleSlowFillsV3),
    expiredDepositsToRefundV3: count2DDictionaryValues(expiredDepositsToRefundV3),
    unexecutableSlowFills: count2DDictionaryValues(unexecutableSlowFills),
  };
}

export function getEndBlockBuffers(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  blockRangeEndBlockBuffer: { [chainId: number]: number }
): number[] {
  // These buffers can be configured by the bot runner. They have two use cases:
  // 1) Validate the end blocks specified in the pending root bundle. If the end block is greater than the latest
  // block for its chain, then we should dispute the bundle because we can't look up events in the future for that
  // chain. However, there are some cases where the proposer's node for that chain is returning a higher HEAD block
  // than the bot-runner is seeing, so we can use this buffer to allow the proposer some margin of error. If
  // the bundle end block is less than HEAD but within this buffer, then we won't dispute and we'll just exit
  // early from this function.
  // 2) Subtract from the latest block in a new root bundle proposal. This can be used to reduce the chance that
  // bot runs using different providers see different contract state close to the HEAD block for a chain.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) => blockRangeEndBlockBuffer[chainId] ?? 0);
}

export async function _buildPoolRebalanceRoot(
  latestMainnetBlock: number,
  mainnetBundleEndBlock: number,
  bundleV3Deposits: BundleDepositsV3,
  bundleFillsV3: BundleFillsV3,
  bundleSlowFillsV3: BundleSlowFills,
  unexecutableSlowFills: BundleExcessSlowFills,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
  clients: {
    hubPoolClient: HubPoolClient;
    configStoreClient: AcrossConfigStoreClient;
    bundleDataClient: BundleDataClient;
    spokePoolClients: SpokePoolClientsByChain;
  },
  maxL1TokenCountOverride?: number
): Promise<PoolRebalanceRoot> {
  // Running balances are the amount of tokens that we need to send to each SpokePool to pay for all instant and
  // slow relay refunds. They are decreased by the amount of funds already held by the SpokePool. Balances are keyed
  // by the SpokePool's network and L1 token equivalent of the L2 token to refund.
  // Realized LP fees are keyed the same as running balances and represent the amount of LP fees that should be paid
  // to LP's for each running balance.

  // For each FilledV3Relay group, identified by { repaymentChainId, L1TokenAddress }, initialize a "running balance"
  // to the total refund amount for that group.
  const runningBalances: RunningBalances = {};
  const realizedLpFees: RunningBalances = {};

  // Keep track of any chains that we want to create a PoolRebalanceLeaf (and send a root bundle to) but don't have
  // any running balances.
  const chainWithRefundsOnly = new Set<number>();

  /**
   * REFUNDS FOR FAST FILLS
   */

  // Add running balances and lp fees for v3 relayer refunds using BundleDataClient.bundleFillsV3. Refunds
  // should be equal to inputAmount - lpFees so that relayers get to keep the relayer fee. Add the refund amount
  // to the running balance for the repayment chain.
  Object.entries(bundleFillsV3).forEach(([_repaymentChainId, fillsForChain]) => {
    const repaymentChainId = Number(_repaymentChainId);
    Object.entries(fillsForChain).forEach(
      ([l2TokenAddress, { realizedLpFees: totalRealizedLpFee, totalRefundAmount }]) => {
        // If the repayment token and repayment chain ID do not map to a PoolRebalanceRoute graph, then
        // there are no relevant L1 running balances.
        if (
          !clients.hubPoolClient.l2TokenHasPoolRebalanceRoute(
            toAddressType(l2TokenAddress, repaymentChainId),
            repaymentChainId,
            mainnetBundleEndBlock
          )
        ) {
          chainWithRefundsOnly.add(repaymentChainId);
          return;
        }
        const l1Token = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
          toAddressType(l2TokenAddress, repaymentChainId),
          repaymentChainId,
          mainnetBundleEndBlock
        );
        const l1TokenAddr = l1Token.toNative();
        assert(l1Token.isEVM(), `Expected an EVM address: ${l1TokenAddr}`);

        updateRunningBalance(runningBalances, repaymentChainId, l1TokenAddr, totalRefundAmount);
        updateRunningBalance(realizedLpFees, repaymentChainId, l1TokenAddr, totalRealizedLpFee);
      }
    );
  });

  /**
   * PAYMENTS SLOW FILLS
   */

  // Add running balances and lp fees for v3 slow fills using BundleDataClient.bundleSlowFillsV3.
  // Slow fills should still increment bundleLpFees and updatedOutputAmount should be equal to inputAmount - lpFees.
  // Increment the updatedOutputAmount to the destination chain.
  Object.entries(bundleSlowFillsV3).forEach(([_destinationChainId, depositsForChain]) => {
    const destinationChainId = Number(_destinationChainId);
    Object.entries(depositsForChain).forEach(([outputToken, deposits]) => {
      deposits.forEach((deposit) => {
        const l1TokenCounterpart = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
          toAddressType(outputToken, destinationChainId),
          destinationChainId,
          mainnetBundleEndBlock
        );
        const lpFee = deposit.lpFeePct.mul(deposit.inputAmount).div(fixedPointAdjustment);
        updateRunningBalance(
          runningBalances,
          destinationChainId,
          l1TokenCounterpart.toEvmAddress(),
          deposit.inputAmount.sub(lpFee)
        );
        // Slow fill LP fees are accounted for when the slow fill executes and a V3FilledRelay is emitted. i.e. when
        // the slow fill execution is included in bundleFillsV3.
      });
    });
  });

  /**
   * EXCESSES FROM UNEXECUTABLE SLOW FILLS
   */

  // Subtract destination chain running balances for BundleDataClient.unexecutableSlowFills.
  // These are all slow fills that are impossible to execute and therefore the amount to return would be
  // the updatedOutputAmount = inputAmount - lpFees.
  Object.entries(unexecutableSlowFills).forEach(([_destinationChainId, slowFilledDepositsForChain]) => {
    const destinationChainId = Number(_destinationChainId);
    Object.entries(slowFilledDepositsForChain).forEach(([outputToken, slowFilledDeposits]) => {
      slowFilledDeposits.forEach((deposit) => {
        const l1TokenCounterpart = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
          toAddressType(outputToken, destinationChainId),
          destinationChainId,
          mainnetBundleEndBlock
        );
        const lpFee = deposit.lpFeePct.mul(deposit.inputAmount).div(fixedPointAdjustment);
        updateRunningBalance(
          runningBalances,
          destinationChainId,
          l1TokenCounterpart.toEvmAddress(),
          lpFee.sub(deposit.inputAmount)
        );
        // Slow fills don't add to lpFees, only when the slow fill is executed and a V3FilledRelay is emitted, so
        // we don't need to subtract it here. Moreover, the HubPoole expects bundleLpFees to be > 0.
      });
    });
  });

  /**
   * DEPOSITS
   */

  // Handle v3Deposits. These decrement running balances from the origin chain equal to the inputAmount.
  // There should not be early deposits in v3.
  Object.entries(bundleV3Deposits).forEach(([, depositsForChain]) => {
    Object.entries(depositsForChain).forEach(([, deposits]) => {
      deposits.forEach((deposit) => {
        // If the repayment token and repayment chain ID do not map to a PoolRebalanceRoute graph, then
        // there are no relevant L1 running balances.
        if (
          !clients.hubPoolClient.l2TokenHasPoolRebalanceRoute(
            deposit.inputToken,
            deposit.originChainId,
            mainnetBundleEndBlock
          )
        ) {
          return;
        }
        updateRunningBalanceForDeposit(
          runningBalances,
          clients.hubPoolClient,
          deposit,
          deposit.inputAmount.mul(-1),
          mainnetBundleEndBlock
        );
      });
    });
  });

  /**
   * REFUNDS FOR EXPIRED DEPOSITS
   */

  // Add origin chain running balance for expired v3 deposits. These should refund the inputAmount.
  Object.entries(expiredDepositsToRefundV3).forEach(([_originChainId, depositsForChain]) => {
    const originChainId = Number(_originChainId);
    Object.entries(depositsForChain).forEach(([inputToken, deposits]) => {
      deposits.forEach((deposit) => {
        // If the repayment token and repayment chain ID do not map to a PoolRebalanceRoute graph, then
        // there are no relevant L1 running balances.
        if (
          !clients.hubPoolClient.l2TokenHasPoolRebalanceRoute(
            deposit.inputToken,
            deposit.originChainId,
            mainnetBundleEndBlock
          )
        ) {
          chainWithRefundsOnly.add(deposit.originChainId);
          return;
        }
        const l1TokenCounterpart = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
          toAddressType(inputToken, originChainId),
          originChainId,
          mainnetBundleEndBlock
        );
        updateRunningBalance(runningBalances, originChainId, l1TokenCounterpart.toEvmAddress(), deposit.inputAmount);
      });
    });
  });

  // Add to the running balance value from the last valid root bundle proposal. A root bundle proposal which is still in liveness and has not yet been executed counts as a valid proposal.
  // If the mainnetBundleEndBlock for this pool rebalance root corresponds to the pending root bundle or some root bundle before the pending root bundle, then we can fetch running balances directly from `ExecutedRootBundle` events.
  if (
    clients.hubPoolClient.getPendingRootBundle()?.bundleEvaluationBlockNumbers[0] === mainnetBundleEndBlock ||
    !clients.hubPoolClient.hasPendingProposal() ||
    clients.hubPoolClient
      .getValidatedRootBundles()
      .some((bundle) => bundle.bundleEvaluationBlockNumbers[0].toNumber() === mainnetBundleEndBlock)
  ) {
    addLastRunningBalance(latestMainnetBlock, runningBalances, clients.hubPoolClient);
  } else {
    // Otherwise, the pool rebalance root for this root bundle must be for an optimistic proposal, so we need to reconstruct the pool rebalance root for the pending root bundle to obtain the running balances.
    // @dev It is safe to index the hub pool client's proposed root bundles here since there is guaranteed to be a pending proposal in this code block.
    const mostRecentProposedRootBundle = clients.hubPoolClient.getLatestProposedRootBundle();
    const blockRangesForChains = getImpliedBundleBlockRanges(
      clients.hubPoolClient,
      clients.configStoreClient,
      mostRecentProposedRootBundle
    );
    // We are loading data from a pending root bundle, so we want to use arweave if possible.
    const prevRootBundleData = await clients.bundleDataClient.loadData(
      blockRangesForChains,
      clients.spokePoolClients,
      true
    );
    const prevPoolRebalanceRoot = await _buildPoolRebalanceRoot(
      latestMainnetBlock,
      blockRangesForChains[0][1],
      prevRootBundleData.bundleDepositsV3,
      prevRootBundleData.bundleFillsV3,
      prevRootBundleData.bundleSlowFillsV3,
      prevRootBundleData.unexecutableSlowFills,
      prevRootBundleData.expiredDepositsToRefundV3,
      clients,
      maxL1TokenCountOverride
    );
    // Update the running balances by adding the pending root bundle's running balance amounts to this bundle's running balances.
    const { runningBalances: prevRunningBalances } = prevPoolRebalanceRoot;
    Object.keys(runningBalances).forEach((repaymentChainId) => {
      Object.keys(runningBalances[Number(repaymentChainId)]).forEach((l1TokenAddress) => {
        const updateRunningBalanceAmount = prevRunningBalances[Number(repaymentChainId)]?.[l1TokenAddress];
        // If the pending root bundle didn't have a running balance, fall back to the last running balance for that token and chain pair.
        const { runningBalance: fallbackRunningBalance } = clients.hubPoolClient.getRunningBalanceBeforeBlockForChain(
          latestMainnetBlock,
          Number(repaymentChainId),
          EvmAddress.from(l1TokenAddress)
        );
        updateRunningBalance(
          runningBalances,
          Number(repaymentChainId),
          l1TokenAddress,
          updateRunningBalanceAmount ?? fallbackRunningBalance
        );
      });
    });
  }

  const leaves: PoolRebalanceLeaf[] = constructPoolRebalanceLeaves(
    mainnetBundleEndBlock,
    runningBalances,
    realizedLpFees,
    Array.from(chainWithRefundsOnly).filter((chainId) => !Object.keys(runningBalances).includes(chainId.toString())),
    clients.configStoreClient,
    maxL1TokenCountOverride
  );

  return {
    runningBalances,
    realizedLpFees,
    leaves,
    tree: buildPoolRebalanceLeafTree(leaves),
  };
}
