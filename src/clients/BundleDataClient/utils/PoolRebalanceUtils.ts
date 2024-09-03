import { MerkleTree } from "@across-protocol/contracts/dist/utils/MerkleTree";
import { RunningBalances, PoolRebalanceLeaf, Clients, SpokePoolTargetBalance } from "../../../interfaces";
import { SpokePoolClient } from "../../SpokePoolClient";
import { BigNumber } from "ethers";
import { bnZero, compareAddresses } from "../../../utils";
import { HubPoolClient } from "../../HubPoolClient";
import { V3DepositWithBlock } from "./shims";
import { AcrossConfigStoreClient } from "../../AcrossConfigStoreClient";

export type PoolRebalanceRoot = {
  runningBalances: RunningBalances;
  realizedLpFees: RunningBalances;
  leaves: PoolRebalanceLeaf[];
  tree: MerkleTree<PoolRebalanceLeaf>;
};

// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the expected start blocks, which are the
// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  spokeClients: { [chainId: number]: SpokePoolClient },
  endBlockBuffers: number[],
  clients: Clients,
  latestMainnetBlock: number,
  enabledChains: number[]
): number[][] {
  // We impose a buffer on the head of the chain to increase the probability that the received blocks are final.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  const latestPossibleBundleEndBlockNumbers = chainIdListForBundleEvaluationBlockNumbers.map(
    (chainId: number, index) =>
      spokeClients[chainId] && Math.max(spokeClients[chainId].latestBlockSearched - endBlockBuffers[index], 0)
  );
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => {
    const lastEndBlockForChain = clients.hubPoolClient.getLatestBundleEndBlockForChain(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    );

    // If chain is disabled, re-use the latest bundle end block for the chain as both the start
    // and end block.
    if (!enabledChains.includes(chainId)) {
      return [lastEndBlockForChain, lastEndBlockForChain];
    } else {
      // If the latest block hasn't advanced enough from the previous proposed end block, then re-use it. It will
      // be regarded as disabled by the Dataworker clients. Otherwise, add 1 to the previous proposed end block.
      if (lastEndBlockForChain >= latestPossibleBundleEndBlockNumbers[index]) {
        // @dev: Without this check, then `getNextBundleStartBlockNumber` could return `latestBlock+1` even when the
        // latest block for the chain hasn't advanced, resulting in an invalid range being produced.
        return [lastEndBlockForChain, lastEndBlockForChain];
      } else {
        // Chain has advanced far enough including the buffer, return range from previous proposed end block + 1 to
        // latest block for chain minus buffer.
        return [
          clients.hubPoolClient.getNextBundleStartBlockNumber(
            chainIdListForBundleEvaluationBlockNumbers,
            latestMainnetBlock,
            chainId
          ),
          latestPossibleBundleEndBlockNumbers[index],
        ];
      }
    }
  });
}

export function isChainDisabled(blockRangeForChain: number[]): boolean {
  return blockRangeForChain[0] === blockRangeForChain[1];
}

// Note: this function computes the intended transfer amount before considering the transfer threshold.
// A positive number indicates a transfer from hub to spoke.
export function computeDesiredTransferAmountToSpoke(
  runningBalance: BigNumber,
  spokePoolTargetBalance: SpokePoolTargetBalance
): BigNumber {
  // Transfer is always desired if hub owes spoke.
  if (runningBalance.gte(0)) {
    return runningBalance;
  }

  // Running balance is negative, but its absolute value is less than the spoke pool target balance threshold.
  // In this case, we transfer nothing.
  if (runningBalance.abs().lt(spokePoolTargetBalance.threshold)) {
    return bnZero;
  }

  // We are left with the case where the spoke pool is beyond the threshold.
  // A transfer needs to be initiated to bring it down to the target.
  const transferSize = runningBalance.abs().sub(spokePoolTargetBalance.target);

  // If the transferSize is < 0, this indicates that the target is still above the running balance.
  // This can only happen if the threshold is less than the target. This is likely due to a misconfiguration.
  // In this case, we transfer nothing until the target is exceeded.
  if (transferSize.lt(0)) {
    return bnZero;
  }

  // Negate the transfer size because a transfer from spoke to hub is indicated by a negative number.
  return transferSize.mul(-1);
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  return computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
}

export function getRunningBalanceForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  const desiredTransferAmount = computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
  return runningBalance.sub(desiredTransferAmount);
}

export function updateRunningBalance(
  runningBalances: RunningBalances,
  l2ChainId: number,
  l1Token: string,
  updateAmount: BigNumber
): void {
  // Initialize dictionary if empty.
  if (!runningBalances[l2ChainId]) {
    runningBalances[l2ChainId] = {};
  }
  const runningBalance = runningBalances[l2ChainId][l1Token];
  if (runningBalance) {
    runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
  } else {
    runningBalances[l2ChainId][l1Token] = updateAmount;
  }
}

export function addLastRunningBalance(
  latestMainnetBlock: number,
  runningBalances: RunningBalances,
  hubPoolClient: HubPoolClient
): void {
  Object.keys(runningBalances).forEach((repaymentChainId) => {
    Object.keys(runningBalances[Number(repaymentChainId)]).forEach((l1TokenAddress) => {
      const { runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        latestMainnetBlock,
        Number(repaymentChainId),
        l1TokenAddress
      );
      if (!runningBalance.eq(bnZero)) {
        updateRunningBalance(runningBalances, Number(repaymentChainId), l1TokenAddress, runningBalance);
      }
    });
  });
}

export function updateRunningBalanceForDeposit(
  runningBalances: RunningBalances,
  hubPoolClient: HubPoolClient,
  deposit: V3DepositWithBlock,
  updateAmount: BigNumber
): void {
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    deposit.inputToken,
    deposit.originChainId,
    deposit.quoteBlockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

export function constructPoolRebalanceLeaves(
  latestMainnetBlock: number,
  runningBalances: RunningBalances,
  realizedLpFees: RunningBalances,
  configStoreClient: AcrossConfigStoreClient,
  maxL1TokenCount?: number
): PoolRebalanceLeaf[] {
  // Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
  // we'll split up any leaves with too many L1 tokens.
  const leaves: PoolRebalanceLeaf[] = [];
  Object.keys(runningBalances)
    .map((chainId) => Number(chainId))
    // Leaves should be sorted by ascending chain ID
    .sort((chainIdA, chainIdB) => chainIdA - chainIdB)
    .map((chainId) => {
      // Sort addresses.
      const sortedL1Tokens = Object.keys(runningBalances[chainId]).sort((addressA, addressB) => {
        return compareAddresses(addressA, addressB);
      });

      // This begins at 0 and increments for each leaf for this { chainId, L1Token } combination.
      let groupIndexForChainId = 0;

      // Split addresses into multiple leaves if there are more L1 tokens than allowed per leaf.
      const maxL1TokensPerLeaf =
        maxL1TokenCount || configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(latestMainnetBlock);
      for (let i = 0; i < sortedL1Tokens.length; i += maxL1TokensPerLeaf) {
        const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxL1TokensPerLeaf);

        const spokeTargetBalances = l1TokensToIncludeInThisLeaf.map((l1Token) =>
          configStoreClient.getSpokeTargetBalancesForBlock(l1Token, chainId, latestMainnetBlock)
        );

        // Build leaves using running balances and realized lp fees data for l1Token + chain, or default to
        // zero if undefined.
        const leafBundleLpFees = l1TokensToIncludeInThisLeaf.map(
          (l1Token) => realizedLpFees[chainId]?.[l1Token] ?? bnZero
        );
        const leafNetSendAmounts = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId] && runningBalances[chainId][l1Token]
            ? getNetSendAmountForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );
        const leafRunningBalances = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId]?.[l1Token]
            ? getRunningBalanceForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );

        leaves.push({
          chainId: chainId,
          bundleLpFees: leafBundleLpFees,
          netSendAmounts: leafNetSendAmounts,
          runningBalances: leafRunningBalances,
          groupIndex: groupIndexForChainId++,
          leafId: leaves.length,
          l1Tokens: l1TokensToIncludeInThisLeaf,
        });
      }
    });
  return leaves;
}
