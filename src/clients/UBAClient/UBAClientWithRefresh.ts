import assert from "assert";
import winston from "winston";
import { SpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { BaseUBAClient } from "./UBAClientBase";
import {
  computeLpFeeForRefresh,
  flowComparisonFunction,
  getBundleKeyForFlow,
  getFlowChain,
  getFlows,
  getMostRecentBundleBlockRanges,
  getUBAFeeConfig,
  sortFlowsAscending,
} from "./UBAClientUtilities";
import { ModifiedUBAFlow, UBABundleState, UBAClientState } from "./UBAClientTypes";
import { UbaFlow, UbaInflow, isUbaInflow, outflowIsFill } from "../../interfaces";
import { findLast, getBlockForChain, getBlockRangeForChain, isDefined, mapAsync } from "../../utils";
import { analog } from "../../UBAFeeCalculator";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import { BigNumber } from "ethers";
export class UBAClientWithRefresh extends BaseUBAClient {
  public chainIdIndices: number[];

  // We should cache this data structure in Redis:
  // chainId => JSON.stringify(blockRanges) => flows
  public validatedFlowsPerBundle: Record<number, Record<string, ModifiedUBAFlow[]>> = {};

  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    readonly tokens: string[],
    protected readonly hubPoolClient: HubPoolClient,
    public readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly maxBundleStates: number,
    readonly logger?: winston.Logger
  ) {
    super(tokens, maxBundleStates, hubPoolClient.chainId, logger);
    this.chainIdIndices = Object.keys(this.spokePoolClients).map((chainId) => Number(chainId));
    assert(this.chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  _getBundleStateContainingBlock(chainId: number, tokenSymbol: string, block: number): UBABundleState {
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    const specificBundleState = findLast(
      relevantBundleStates,
      (bundleState) => bundleState.openingBlockNumberForSpokeChain <= block
    );
    if (!specificBundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    }

    // If there are no flows in the bundle AFTER the balancingActionBlockNumber then its safer to throw an error
    // then risk returning an invalid Balancing fee because we're missing flows preceding the
    //  balancingActionBlockNumber.
    if (specificBundleState.closingBlockNumberForSpokeChain < block) {
      throw new Error(
        `Bundle end block ${specificBundleState.closingBlockNumberForSpokeChain} doesn't cover flow block ${block}`
      );
    }

    return specificBundleState;
  }

  /**
   * @notice Intended to be called by Relayer to set `realizedLpFeePct` for a deposit.
   */
  public computeFeesForDeposit(deposit: UbaInflow): {
    lpFee: BigNumber;
    relayerBalancingFee: BigNumber;
    depositBalancingFee: BigNumber;
  } {
    const tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
    if (!tokenSymbol) throw new Error("No token symbol found");
    const specificBundleState = this._getBundleStateContainingBlock(
      deposit.originChainId,
      tokenSymbol,
      deposit.blockNumber
    );

    // Find matching flow in bundle state:
    const matchingFlow = specificBundleState.flows.find(({ flow }) => {
      // TODO: Is there more validation needed here? I assume no because the bundle states are already
      // sanitized on update()
      return flow.depositId === deposit.depositId && flow.originChainId === deposit.originChainId;
    });
    if (!matchingFlow) {
      throw new Error("Found bundle state containing flow but no matching flow found for deposit");
    }

    // Figure out approximate relayer balancing fee if deposit was relayed and refunded on destination chain
    const { runningBalance, incentiveBalance } = analog.calculateHistoricalRunningBalance(
      // All flows in bundle preceding deposit
      specificBundleState.flows.filter((f) => flowComparisonFunction(f.flow, deposit) <= 0).map(({ flow }) => flow),
      specificBundleState.openingBalance,
      specificBundleState.openingIncentiveBalance,
      deposit.destinationChainId,
      tokenSymbol,
      specificBundleState.config
    );
    const { balancingFee } = getRefundFee(
      deposit.amount,
      runningBalance,
      incentiveBalance,
      deposit.destinationChainId,
      specificBundleState.config
    );

    return {
      lpFee: matchingFlow.lpFee,
      relayerBalancingFee: balancingFee,
      depositBalancingFee: matchingFlow.balancingFee,
    };
  }

  /**
   * Validate flows in bundle block ranges.
   * @param blockRanges
   * @param tokenSymbol
   * @returns
   */
  public async validateFlowsInBundle(blockRanges: number[][], tokenSymbol: string): Promise<void> {
    // Load common data:
    const l1TokenAddress = this.hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol)?.address;
    if (!l1TokenAddress) throw new Error("No L1 token address found for token symbol");

    // 00. Load latest block.timestamps for each chain.

    // 0. Conveniently map block ranges to each chain.
    const blockRangesForChain: Record<number, number[]> = Object.fromEntries(
      this.chainIdIndices.map((chainId) => {
        if (!isDefined(this.validatedFlowsPerBundle[chainId])) {
          this.validatedFlowsPerBundle[chainId] = {};
        }
        return [chainId, getBlockRangeForChain(blockRanges, chainId, this.chainIdIndices)];
      })
    );

    // 1. Combine flows from all chain block ranges in this bundle.
    const flowsInBundle = sortFlowsAscending(
      (
        await mapAsync(this.chainIdIndices, async (chainId) => {
          const [startBlock, endBlock] = blockRangesForChain[chainId];
          // TODO: Cache this getFlows result to make more performant.
          // If getFlows doesn't error, then all fills in the range have been matched against a deposit in another
          // spoke client's memory. If this errors, then we'll need to widen the spoke pool client's lookback
          // to find the older deposit. This would greatly reduce runtime for this bot so we should cache the
          // result of this function so that future calls can more easily validate an outflow against a cached inflow.
          return await getFlows(tokenSymbol, chainId, this.spokePoolClients, this.hubPoolClient, startBlock, endBlock);
        })
      ).flat()
    );

    // 3. Validate all flows in ascending order. We don't want to do these in parallel we actually want to do
    // these sequentially.
    for (const flow of flowsInBundle) {
      const flowChain = getFlowChain(flow);
      const bundleKey = getBundleKeyForFlow(flow.blockNumber, flowChain, this.hubPoolClient);
      if (!isDefined(this.validatedFlowsPerBundle[flowChain][bundleKey])) {
        this.validatedFlowsPerBundle[flowChain][bundleKey] = [];
      }
      console.log(`Trying to validate flow for chain ${flowChain} and key ${bundleKey}`);
      // Since we're validating flows in ascending order, all flows in this array have already been validated
      // and precede the flow.
      const precedingValidatedFlows = this.validatedFlowsPerBundle[flowChain][bundleKey];
      const validatedFlow = await this.validateFlow(flow, precedingValidatedFlows);
      if (isDefined(validatedFlow)) {
        console.log(`Validated flow for chain ${flowChain} and key ${bundleKey}`, validatedFlow);
        this.validatedFlowsPerBundle[flowChain][bundleKey].push(validatedFlow);
      } else {
        console.log("Invalidated flow", flow);
      }
    }
  }

  /**
   * Return flow with computed fees if it is valid. Otherwise, return undefined. Inflows are always valid,
   * while outflows need to match against an inflow and set the correct system fee.
   * @param flow
   * @returns
   */
  async validateFlow(
    flow: UbaFlow,
    precedingValidatedFlows: ModifiedUBAFlow[] = []
  ): Promise<ModifiedUBAFlow | undefined> {
    const latestHubPoolBlock = this.hubPoolClient.latestBlockNumber;
    if (!isDefined(latestHubPoolBlock)) throw new Error("HubPoolClient not updated");
    // ASSUMPTION: When calling this function, the caller assumes that all flows loaded by the SpokePoolClients
    // with a block.timestamp < flow.block.timestamp have already been validated. This means that we can
    // assume that `this.validatedFlowsPerChain` is updated through the flow.block.timestamp.

    // Load common information that depends on what type of flow we're validating:
    // For a deposit, the flow happens on the origin chain.
    // For a refund or fill, the flow happens on the repayment or destination chain.
    let flowChain: number, tokenSymbol: string | undefined;
    if (isUbaInflow(flow)) {
      flowChain = flow.originChainId;

      // // If the flow is a deposit, then we might have already validated it.
      // const existingValidatedDeposit = this.validatedFlowsPerChain[flowChain].find((f) => f.flow.depositId === flow.depositId)
      // if (isDefined(existingValidatedDeposit)) {
      //   return existingValidatedDeposit
      // }
      tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(flow.originToken, flowChain)?.symbol;
    } else {
      // If outflow, we need to make sure that the matched deposit is not a pre UBA deposit. pre UBA deposits
      // have defined realizedLpFeePct's at this stage:
      if (isDefined(flow.matchedDeposit.realizedLpFeePct)) {
        return undefined;
      }
      // If the flow is a fill, then we need to validate its matched deposit.
      if (outflowIsFill(flow)) {
        flowChain = flow.destinationChainId;
        tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(flow.destinationToken, flowChain)?.symbol;
      } else {
        flowChain = flow.repaymentChainId;
        tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(flow.refundToken, flowChain)?.symbol;
      }
    }
    if (!isDefined(tokenSymbol)) throw new Error("No token symbol found");
    const l1TokenAddress = this.hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol)?.address;
    if (!isDefined(l1TokenAddress)) throw new Error("No L1 token address found for token symbol");

    // Get opening balance and config at the time of the bundle containing the flow. We basically want to grab
    // the latest validated bundle preceding the bundle containing the flow.
    const startBlocks = this.hubPoolClient.getBundleStartBlocksForProposalContainingBlock(flow.blockNumber, flowChain);
    const mainnetStartBlock = getBlockForChain(
      startBlocks,
      this.hubPoolClient.chainId,
      this.hubPoolClient.configStoreClient.enabledChainIds
    );
    // TODO: Fix this: get running balance for bundle.
    const openingBalanceForChain = this.hubPoolClient.getOpeningRunningBalanceForEvent(
      flow.blockNumber,
      flowChain,
      l1TokenAddress
    );
    const ubaConfigForChain = getUBAFeeConfig(this.hubPoolClient, flowChain, tokenSymbol, mainnetStartBlock);

    console.log(
      `Opening balance for chain ${flowChain} and block ${flow.blockNumber} for ${l1TokenAddress}`,
      openingBalanceForChain
    );
    console.log(`Loaded latest UBA config as of ${mainnetStartBlock}`);
    // Figure out the running balance so far for this flow's chain. This is based on all already validated flows
    // for this chain.
    const {
      runningBalance: flowOpeningRunningBalance,
      incentiveBalance: flowOpeningIncentiveBalance,
      netRunningBalanceAdjustment: flowOpeningNetRunningBalanceAdjustment,
    } = analog.calculateHistoricalRunningBalance(
      precedingValidatedFlows.map(({ flow }) => flow),
      openingBalanceForChain.runningBalance,
      openingBalanceForChain.incentiveBalance,
      flowChain,
      tokenSymbol,
      ubaConfigForChain
    );

    // Use the opening balance to compute expected flow fees:
    let balancingFee: BigNumber;
    if (isUbaInflow(flow)) {
      ({ balancingFee } = getDepositFee(
        flow.amount,
        flowOpeningRunningBalance,
        flowOpeningIncentiveBalance,
        flowChain,
        ubaConfigForChain
      ));
    } else {
      ({ balancingFee } = getRefundFee(
        flow.amount,
        flowOpeningRunningBalance,
        flowOpeningIncentiveBalance,
        flowChain,
        ubaConfigForChain
      ));
    }

    // Figure out the LP fee which is based only on the flow's origin and destination chain.
    const lpFee = computeLpFeeForRefresh(ubaConfigForChain.getBaselineFee(flow.destinationChainId, flow.originChainId));

    // Now we have all information we need to validate the flow:
    // If deposit, then flow is always valid:
    if (isUbaInflow(flow)) {
      return {
        flow,
        balancingFee,
        lpFee,
        runningBalance: flowOpeningRunningBalance,
        incentiveBalance: flowOpeningIncentiveBalance,
        netRunningBalanceAdjustment: flowOpeningNetRunningBalanceAdjustment,
      };
    } else {
      // Now we need to validate the refund or fill.
      // ASSUMPTION: the flow is already matched against a deposit, so it suffices
      // only to check if the fill matches with a valid deposit.

      // Rule 1. The fill must match with a deposit who's blockTimestamp is < fill.blockTimestamp.
      if (flow.blockTimestamp < flow.matchedDeposit.blockTimestamp) {
        // TODO: We cannot invalidate a fill if the block.timestamp on the deposit.origin chain is not > than the
        // the fill's timestamp. This is because its still possible to send a deposit on the origin chain
        // that would validate this fill. This deposit would then be added to the `validatedFlows[deposit.originChain]`
        // list, which would have made the fill's
        console.log(
          "Flow is invalid because its blockTimestamp is less than its matched deposit's blockTimestamp",
          flow
        );
      } else {
        // Rule 2: Validate the fill.realizedLpFeePct against the expected matched deposit systemFee.

        // We need to figure out the system fee for the matched deposit. We assume that the flow has already been
        // validated against a deposit by getFlows() so it suffices to look up the deposit in the spoke pool
        // client's memory. If we can't find it now, then there is an unexpected bug.
        const matchedDeposit = flow.matchedDeposit;
        let matchedDepositFlow: ModifiedUBAFlow | undefined;

        const matchedDepositBundleStartBlocks = this.hubPoolClient.getBundleStartBlocksForProposalContainingBlock(
          matchedDeposit.blockNumber,
          matchedDeposit.originChainId
        );
        const matchedDepositBundleKey = getBundleKeyForFlow(
          matchedDeposit.blockNumber,
          matchedDeposit.originChainId,
          this.hubPoolClient
        );

        // // If bundle key and matched deposit bundle key are the same then the matched deposit should be in the
        // // same bundle as the fill.
        // const bundleKey = getBundleKeyForFlow(flow.blockNumber, flowChain, this.hubPoolClient);
        // if (matchedDepositBundleKey === bundleKey) {
        //   matchedDepositFlow = precedingValidatedFlows.find(
        //     ({ flow }) =>
        //       flow.depositId === matchedDeposit.depositId && flow.originChainId === matchedDeposit.originChainId
        //   );
        //   if (!isDefined(matchedDepositFlow)) {
        //     throw new Error(`Could not find matched deposit in same bundle as fill`)
        //   } else {
        //     console.log(`Found matched deposit in same bundle as fill`, matchedDepositFlow)
        //   }
        // }

        // Try to see if we can easily
        // look up cached flow information using the matchedDepositBundleKey and flow.matchedDeposit.originChainId.
        const cache_matchedDepositBundleFlows =
          this.validatedFlowsPerBundle?.[matchedDeposit.originChainId]?.[matchedDepositBundleKey];
        if (isDefined(cache_matchedDepositBundleFlows)) {
          console.log(
            `Looking in cache for matched deposit ${matchedDeposit.originChainId} and ${matchedDepositBundleKey}}`
          );
          matchedDepositFlow = cache_matchedDepositBundleFlows.find(
            ({ flow }) =>
              flow.depositId === matchedDeposit.depositId && flow.originChainId === matchedDeposit.originChainId
          );
        } else {
          console.log(
            `Could not find cache for ${matchedDeposit.originChainId} and ${matchedDepositBundleKey} when trying to validate flow`
          );
        }

        // If not, then we need to recurse and validate this bundle.
        if (!isDefined(matchedDepositFlow)) {
          const matchedDepositBundleBlockRanges = this.chainIdIndices.map((chainId) => [
            getBlockForChain(
              matchedDepositBundleStartBlocks,
              chainId,
              this.hubPoolClient.configStoreClient.enabledChainIds
            ),
            this.spokePoolClients[chainId].latestBlockSearched,
          ]);
          console.log(
            "We need to recurse to validate the matched deposit",
            flow,
            matchedDepositBundleBlockRanges,
            matchedDepositBundleKey
          );
          process.exit(0);

          // await this.validateFlowsInBundle(matchedDepositBundleBlockRanges, tokenSymbol);
          // const cache_matchedDepositBundleFlows =
          //   this.validatedFlowsPerBundle?.[matchedDeposit.originChainId]?.[matchedDepositBundleKey];
          // matchedDepositFlow = cache_matchedDepositBundleFlows.find(
          //   ({ flow }) =>
          //     flow.depositId === matchedDeposit.depositId && flow.originChainId === matchedDeposit.originChainId
          // );
        }

        // At this point we couldn't find a flow in the cache or from newly validated data that matches the
        // flow.matchedDeposit. This is unexpected and perhaps means we need to widen the spoke pool client lookback.
        if (!isDefined(matchedDepositFlow)) {
          console.log(matchedDepositFlow);
          throw new Error("Could not validate or invalidate matched deposit");
        }
        const expectedRealizedLpFeePctForMatchedDeposit = matchedDepositFlow.lpFee.add(matchedDepositFlow.balancingFee);
        if (expectedRealizedLpFeePctForMatchedDeposit.eq(flow.realizedLpFeePct)) {
          return {
            flow,
            balancingFee,
            lpFee,
            runningBalance: flowOpeningRunningBalance,
            incentiveBalance: flowOpeningIncentiveBalance,
            netRunningBalanceAdjustment: flowOpeningNetRunningBalanceAdjustment,
          };
        } else {
          console.log(
            `Matched deposit was validated by incorrect realized lp fee pct set for outflow, expected ${expectedRealizedLpFeePctForMatchedDeposit.toString()}`
          );
        }
      }
    }
    return undefined;
  }

  /**
   * Returns a convenient mapping of the most recent block ranges for each chain.
   * Assumptions: For each chain, there should be the same number of block ranges returned.
   * @param bundleCount Block ranges to fetch per chain
   * @returns A dictionary mapping chainId to an array of block ranges, where the ranges are arrays of length two
   *         and the first element is the start block and the second element is the end block.
   */
  public getMostRecentBundleBlockRangesPerChain(bundleCount: number): Record<number, number[][]> {
    // Load common data:
    const latestHubPoolBlock = this.hubPoolClient.latestBlockNumber;
    if (!isDefined(latestHubPoolBlock)) throw new Error("HubPoolClient not updated");

    return this.chainIdIndices.reduce((acc, chainId) => {
      // Gets the most recent `bundleCount` block ranges for this chain.
      const _blockRangesForChain = getMostRecentBundleBlockRanges(
        chainId,
        bundleCount,
        latestHubPoolBlock,
        this.hubPoolClient,
        this.spokePoolClients
      ).map(({ start, end }) => [start, end]);
      // Make the last bundle to cover until the last spoke client searched block
      _blockRangesForChain[_blockRangesForChain.length - 1][1] = this.spokePoolClients[chainId].latestBlockSearched;

      // Map the block ranges to this chain and move on to the next chain.
      acc[chainId] = _blockRangesForChain;
      return acc;
    }, {} as Record<number, number[][]>);
  }

  /**
   * Updates the clients and UBAFeeCalculators.
   * @param forceRefresh An optional boolean to force a refresh of the clients.
   */
  public async update(_state?: UBAClientState, _forceClientRefresh?: boolean): Promise<void> {
    console.log("SDK UPDATING");

    // DEMO: Try loading bundle data for the most recent WETH bundle.
    const token = "WETH";

    // Load all UBA bundles for each chain:
    const bundleBlockRangesPerChain = this.getMostRecentBundleBlockRangesPerChain(100);
    console.log("Mapping of block ranges per chain", bundleBlockRangesPerChain);
    const chainIdIndices = Object.keys(bundleBlockRangesPerChain).map((chainId) => Number(chainId));

    // Get the block ranges for all chains from the oldest
    const mostRecentBundleBlockRanges = chainIdIndices.map((chain) => bundleBlockRangesPerChain[chain][0]);
    console.log("Validating flows for bundle", mostRecentBundleBlockRanges);

    // Grab validated flows for this bundle:
    await this.validateFlowsInBundle(mostRecentBundleBlockRanges, token);
    return;
  }
  public get isUpdated(): boolean {
    return (
      this.hubPoolClient.configStoreClient.isUpdated &&
      this.hubPoolClient.isUpdated &&
      Object.values(this.spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated) &&
      this._isUpdated
    );
  }
  public set isUpdated(value: boolean) {
    this._isUpdated = value;
  }
}
