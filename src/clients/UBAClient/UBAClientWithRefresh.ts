import assert from "assert";
import winston from "winston";
import { SpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import {
  computeLpFeeForRefresh,
  getBundleKeyForBlockRanges,
  getFlowChain,
  getFlows,
  getMatchingFlow,
  getMostRecentBundleBlockRanges,
  getUBAFeeConfig,
  sortFlowsAscending,
} from "./UBAClientUtilities";
import { ModifiedUBAFlow, UBAClientState } from "./UBAClientTypes";
import {
  UbaFlow,
  UbaInflow,
  UbaOutflow,
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
  outflowIsRefund,
} from "../../interfaces";
import {
  blockRangesAreInvalidForSpokeClients,
  forEachAsync,
  getBlockForChain,
  getBlockRangeForChain,
  isDefined,
  mapAsync,
} from "../../utils";
import { analog } from "../../UBAFeeCalculator";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import { BigNumber, ethers } from "ethers";
import { BaseAbstractClient } from "../BaseAbstractClient";

/**
 * @notice This class reconstructs UBA bundle data for every bundle that has been created since the
 * UBA activation. Its performance can be signficantly sped up by integrating an external caching layer
 * like IPFS or Redis. It provides an interface that is designed to be called by actors who want to
 * to reconstruct a past bundle's state or validate a live bundle's state in order to evaluate a pending
 * root bundle, propose a new root bundle, or get the latest prices as a relayer or fee quoter.
 */
export class UBAClientWithRefresh extends BaseAbstractClient {
  // Stores bundle data to chains and tokens.
  // Bundle states from older, already validated, bundles should ideally be loaded directly
  // from an external storage layer rather than reconstructed fresh from this class.
  public bundleStates: UBAClientState = {};

  // Convenient variable storing this.hubPoolClient.spokePoolClients
  public chainIdIndices: number[];

  // Stores the validated flows for all tokens seen so far for a bundle (keyed by the bundle block ranges)
  // and a chain. Most of these should ideally be fetched directly from a third party storage layer.
  // JSON.stringify(blockRanges) => token => chainId => flows
  public validatedFlowsPerBundle: Record<string, Record<string, Record<number, ModifiedUBAFlow[]>>> = {};

  // All bundle ranges loaded by this client. Should contain all bundle ranges for all validated bundles
  // as of the UBA activation block that the hub pool client is aware of. This is fast to load
  // since it only depends on HubPoolClient event history.
  public ubaBundleBlockRanges: number[][][] = [];

  // This logger is currently copied from the HubPoolClient's logger.
  public logger: winston.Logger;

  /**
   * @param tokens Tokens to load bundle state for.
   * @param hubPoolClient
   * @param spokePoolClients
   */
  constructor(
    readonly tokens: string[],
    protected readonly hubPoolClient: HubPoolClient,
    public readonly spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    super();
    this.logger = this.hubPoolClient.logger;
    this.chainIdIndices = this.hubPoolClient.configStoreClient.enabledChainIds;
    assert(this.chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  // /////////////////
  //
  //
  // PUBLIC METHODS:
  //
  // /////////////////

  /**
   * @notice Intended to be called by Relayer to set `realizedLpFeePct` for a deposit, where
   * realizedLpFeePct for this deposit should be equal to the lpFee plus the depositBalancingFee.
   * @param deposit Should be the deposit that the caller wants to compute the realizedLpFeePct for.
   */
  public computeFeesForDeposit(deposit: UbaInflow): {
    lpFee: BigNumber;
    depositBalancingFee: BigNumber;
  } {
    this.assertUpdated();

    const tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
    if (!tokenSymbol) throw new Error("No token symbol found");

    // Grab bundle state containing deposit using the bundle state's block ranges.
    const specificBundleState = this.bundleStates[deposit.originChainId][tokenSymbol].find(({ bundleBlockRanges }) => {
      const blockRangeForChain = getBlockRangeForChain(bundleBlockRanges, deposit.originChainId, this.chainIdIndices);
      return blockRangeForChain[0] <= deposit.blockNumber && blockRangeForChain[1] >= deposit.blockNumber;
    });
    if (!specificBundleState) {
      throw new Error("No bundle state found for deposit, have you updated this client?");
    }

    // Find matching flow in bundle state.
    const matchingFlow = getMatchingFlow(specificBundleState.flows, deposit);
    if (!matchingFlow) {
      throw new Error("Found bundle state containing flow but no matching flow found for deposit");
    }

    return {
      lpFee: matchingFlow.lpFee,
      depositBalancingFee: matchingFlow.balancingFee,
    };
  }

  /**
   * @notice Can be used by Relayer to approximate next refund balancing fees on refund chain. This is useful
   * for the relayer because they can only assume that their fill gets mined as the "next" fill on the destination
   * chain.
   */
  public computeBalancingFeeForNextRefund(
    repaymentChainId: number,
    refundTokenSymbol: string,
    amount: BigNumber
  ): BigNumber {
    this.assertUpdated();

    // Grab latest flow to get the latest running balance on the desired refund chain for the desired token.
    const lastBundleState = this.bundleStates[repaymentChainId][refundTokenSymbol].slice(-1)[0];
    const lastFlow = lastBundleState.flows.slice(-1)[0];
    const lastBundleBlockRanges = lastBundleState.bundleBlockRanges;
    const mainnetStartBlock = getBlockRangeForChain(lastBundleBlockRanges, repaymentChainId, this.chainIdIndices)[0];
    const ubaConfigForBundle = getUBAFeeConfig(
      this.hubPoolClient,
      repaymentChainId,
      refundTokenSymbol,
      mainnetStartBlock
    );

    // Compute the fees that would be charged if `amount` was filled by the caller and the fill was
    // slotted in next on this chain.
    const { runningBalance, incentiveBalance } = analog.calculateHistoricalRunningBalance(
      lastBundleState.flows.map(({ flow }) => flow),
      lastFlow.runningBalance,
      lastFlow.incentiveBalance,
      repaymentChainId,
      refundTokenSymbol,
      ubaConfigForBundle
    );
    const { balancingFee } = getRefundFee(
      amount,
      runningBalance,
      incentiveBalance,
      repaymentChainId,
      ubaConfigForBundle
    );
    return balancingFee;
  }

  /**
   * @notice Expected to be called by dataworker to reconstruct bundle roots.
   */
  public getModifiedFlows(
    chainId: number,
    tokenSymbol: string,
    startBlock: number,
    endBlock: number
  ): ModifiedUBAFlow[] {
    this.assertUpdated();

    // Grab all validated flows between start and end block for this chain and token.
    const specificBundleState = this.bundleStates[chainId]?.[tokenSymbol]?.find(({ bundleBlockRanges }) => {
      const blockRangeForChain = getBlockRangeForChain(bundleBlockRanges, chainId, this.chainIdIndices);
      return blockRangeForChain[0] <= startBlock && blockRangeForChain[1] >= endBlock;
    });
    if (!specificBundleState) {
      console.log(
        `- Could not find bundle state for chain ${chainId} and token ${tokenSymbol} containing block range ${startBlock} to ${endBlock}`
      );
      return [];
    }
    return specificBundleState.flows;
  }

  // /////////////////
  //
  //
  // PRIVATE METHODS:
  //
  // /////////////////

  /**
   * Validate flows in bundle block ranges. Returns the flows mapped by chain ID where the flow occurred and also
   * caches the validated flows in this class instance.
   * @param blockRanges The block ranges to validate flows for. Must be a known block range in this.ubaBundleBlockRanges class variable.
   * @param tokenSymbol Flows to filter on.
   * @returns
   */
  private async validateFlowsInBundle(
    blockRanges: number[][],
    tokenSymbol: string
  ): Promise<Record<number, ModifiedUBAFlow[]>> {
    // This should only be called with exact block ranges already stored in this.ubaBundleBlockRanges.
    if (
      !this.ubaBundleBlockRanges.some((bundleBlockRanges) => {
        return JSON.stringify(bundleBlockRanges) === JSON.stringify(bundleBlockRanges);
      })
    ) {
      throw new Error("Invalid block ranges not found in this.ubaBundleBlockRanges state");
    }

    // Load common data:
    const l1TokenAddress = this.hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol)?.address;
    if (!l1TokenAddress) throw new Error("No L1 token address found for token symbol");

    // TODO: Load latest block.timestamps for each chain. We'll use this to decide when we can't invalidate a fill,
    // such as when its matched deposit chain hasn't advanced past the fill's block.timestamp yet. This prevents
    // us from prematurely invalidating a fill that could be validated by a deposit sent now on the origin chain that
    // would still satisfy the requirement that deposit.blockTimestamp < fill.blockTimestamp.

    // Precompute key for cached validated flows. Flows are cached per bundle block ranges and per chain.
    const bundleKeyForBlockRanges = getBundleKeyForBlockRanges(blockRanges);
    if (!isDefined(this.validatedFlowsPerBundle[bundleKeyForBlockRanges])) {
      this.validatedFlowsPerBundle[bundleKeyForBlockRanges] = {};
    }
    if (!isDefined(this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol])) {
      this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol] = {};
    }

    // Exit early if we can find the validated flow data for this bundle from an external storage layer.
    // TODO Should first try to load the flow data here from an IPFS lookup. If that fails, we need to reconstruct it.
    // const cachedValidatedFlowsInBundle: Record<number, ModifiedUBAFlow[] = ipfsClient.get(bundleKeyForBlockRanges)
    // if (isDefined(cachedValidatedFlowsInBundle)) {
    //   this.chainIdIndices.map((chainId) => {
    //     this.validatedFlowsPerBundle[bundleKeyForBlockRanges][chainId] = cachedValidatedFlowsInBundle[chainId]
    //   })
    //   return cachedValidatedFlowsInBundle
    // }

    // We couldn't find this bundle's data in the cache so we need to freshly load it.
    // Make sure our spoke pool clients have a large enough block range to cover this range.
    if (blockRangesAreInvalidForSpokeClients(this.spokePoolClients, blockRanges, this.chainIdIndices)) {
      throw new Error(
        `Spoke pool clients do not have the block ranges necessary to look up data for bundle ranges: ${JSON.stringify(
          blockRanges
        )}`
      );
    }

    // Conveniently map block ranges to each chain.
    const blockRangesForChain: Record<number, number[]> = Object.fromEntries(
      this.chainIdIndices.map((chainId) => {
        if (!isDefined(this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol][chainId])) {
          this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol][chainId] = [];
        }
        return [chainId, getBlockRangeForChain(blockRanges, chainId, this.chainIdIndices)];
      })
    );

    // Combine flows from all chain block ranges in this bundle.
    console.group(`Loading flows for token ${tokenSymbol} for block ranges`, blockRanges);
    const flowsInBundle = sortFlowsAscending(
      (
        await mapAsync(this.chainIdIndices, async (chainId) => {
          const [startBlock, endBlock] = blockRangesForChain[chainId];

          // Don't load flows for disabled block ranges in this bundle.
          if (startBlock === endBlock) {
            console.log(`- Chain ${chainId} disabled, skipping`);
            return [];
          }

          // TODO: Cache this getFlows result to make more performant.
          const flows = await getFlows(
            tokenSymbol,
            chainId,
            this.spokePoolClients,
            this.hubPoolClient,
            startBlock,
            endBlock
          );
          console.log(`- Chain ${chainId} flows length: ${flows.length}`);

          // Print out readable breakdown of flows.
          const prettyFlows = flows.reduce(
            (acc, flow) => {
              if (isUbaOutflow(flow) && outflowIsFill(flow)) {
                acc.fills += 1;
              } else if (isUbaOutflow(flow) && outflowIsRefund(flow)) {
                acc.refunds += 1;
              } else {
                acc.deposits += 1;
              }
              return acc;
            },
            { fills: 0, refunds: 0, deposits: 0 }
          );
          console.log("- flow breakdown:", prettyFlows);
          return flows;
        })
      ).flat()
    );
    console.groupEnd();

    // Validate all flows in ascending order. We don't want to do these in parallel we actually want to do
    // these sequentially. This will work assuming that all outflows can only be validated against inflows that
    // are earlier than them in the stream of flows, which is enforced by the `sortFlowsAscending`
    // above. Without this total ordering, a circle in the linked list of outflows => inflow could cause
    // balancing fees to be impossible to compute.
    for (const flow of flowsInBundle) {
      // The flow chain is where the flow occurred, based on what type of flow it was.
      const flowChain = getFlowChain(flow);

      // Since we're validating flows in ascending order, all flows in this array have already been validated
      // and precede the flow.
      const precedingValidatedFlows = this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol][flowChain];
      console.group(`Trying to validate flow for chain ${flowChain} and key ${bundleKeyForBlockRanges}`, {
        isUbaInflow: isUbaInflow(flow),
        isUbaOutflow: isUbaOutflow(flow),
        flowChain,
        transactionhash: flow.transactionHash,
        amount: flow.amount,
        blockTimestamp: flow.blockTimestamp,
        blockNumber: flow.blockNumber,
        realizedLpFeePct: flow.realizedLpFeePct,
        matchedDeposit: (flow as UbaOutflow)?.matchedDeposit && {
          originChain: (flow as UbaOutflow).matchedDeposit.originChainId,
          transactionhash: (flow as UbaOutflow).matchedDeposit.transactionHash,
          blockTimestamp: (flow as UbaOutflow).matchedDeposit.blockTimestamp,
          blockNumber: (flow as UbaOutflow).matchedDeposit.blockNumber,
          // This should be defined only if its a pre UBA deposit.
          realizedLpFeePct: (flow as UbaOutflow).matchedDeposit?.realizedLpFeePct,
        },
      });

      // Validate this flow and cache it if it is valid.
      console.log(`- precedingValidatedFlows length: ${precedingValidatedFlows.length}`);
      const validatedFlow = await this.validateFlow(flow, precedingValidatedFlows);
      if (isDefined(validatedFlow)) {
        console.log("Validated ✅", {
          runningBalance: validatedFlow.runningBalance,
          incentiveBalance: validatedFlow.incentiveBalance.toString(),
          netRunningBalanceAdjustment: validatedFlow.netRunningBalanceAdjustment.toString(),
          balancingFee: validatedFlow.balancingFee.toString(),
          lpFee: validatedFlow.lpFee.toString(),
        });
        this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol][flowChain].push(validatedFlow);

        // We can now set the realizedLpFeePct for the deposit in the SpokePoolClient, which was not
        // known to the SpokePoolClient at the time it queried the deposit.
        if (isUbaOutflow(validatedFlow.flow) && !isDefined(validatedFlow.flow.matchedDeposit.realizedLpFeePct)) {
          console.log("👾 Validated outflow, updating its matched deposit's realizedLpFeePct");
          this.spokePoolClients[validatedFlow.flow.matchedDeposit.originChainId].updateDepositRealizedLpFeePct(
            validatedFlow.flow.matchedDeposit,
            validatedFlow.flow.realizedLpFeePct
          );
        }
      } else {
        console.log("Invalidated flow ❌");
      }
      console.groupEnd();
    }

    return Object.fromEntries(
      this.chainIdIndices.map((chainId) => {
        return [chainId, this.validatedFlowsPerBundle[bundleKeyForBlockRanges][tokenSymbol][chainId]];
      })
    );
  }

  /**
   * Return flow with computed fees if it is valid. Otherwise, return undefined. Inflows are always valid,
   * while outflows need to match against an inflow and have set the correct realizedLpFeePct
   * @param flow
   * @param precedingValidatedFlows TODO: This could be removed if we read directly from the cache since
   * one assumption we make is that flows are validated in ascending order, meaning that all flows
   * returned by this.validatedFlowsPerBundle for this flow's bundleKey and chain precede this flow. Moreover,
   * this preceding set shouldn't be modified anymore.
   * @returns
   */
  private async validateFlow(
    flow: UbaFlow,
    precedingValidatedFlows: ModifiedUBAFlow[] = []
  ): Promise<ModifiedUBAFlow | undefined> {
    const latestHubPoolBlock = this.hubPoolClient.latestBlockNumber;
    if (!isDefined(latestHubPoolBlock)) throw new Error("HubPoolClient not updated");

    // Load common information that depends on what type of flow we're validating:
    let flowChain: number, tokenSymbol: string | undefined;
    if (isUbaInflow(flow)) {
      flowChain = flow.originChainId;
      tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(flow.originToken, flowChain)?.symbol;
    } else {
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
    const blockRangesContainingFlow = this.getUbaBundleBlockRangeContainingFlow(flow.blockNumber, flowChain);
    const startBlocks = blockRangesContainingFlow.map(([start]) => start);
    const mainnetStartBlock = getBlockForChain(
      startBlocks,
      this.hubPoolClient.chainId,
      this.hubPoolClient.configStoreClient.enabledChainIds
    );
    const openingBalanceForChain = this.hubPoolClient.getOpeningRunningBalanceForEvent(
      flow.blockNumber,
      flowChain,
      l1TokenAddress,
      latestHubPoolBlock
    );
    const ubaConfigForChain = getUBAFeeConfig(this.hubPoolClient, flowChain, tokenSymbol, mainnetStartBlock);
    console.log("- Bundle information for flow", {
      blockRangesContainingFlow,
      openingBalanceForChain,
      ubaConfigBaselineFeeCurve: ubaConfigForChain
        .getBaselineFee(flow.destinationChainId, flow.originChainId)
        .toString(),
    });

    // Figure out the running balance so far for this flow's chain. This is based on all already validated flows
    // for this chain plus the current flow assuming it is valid.
    const { runningBalance, incentiveBalance, netRunningBalanceAdjustment } = analog.calculateHistoricalRunningBalance(
      precedingValidatedFlows.map(({ flow }) => flow).concat(flow),
      openingBalanceForChain.runningBalance,
      openingBalanceForChain.incentiveBalance,
      flowChain,
      tokenSymbol,
      ubaConfigForChain
    );

    // Use the opening balance to compute expected flow fees:
    let balancingFee: BigNumber;
    if (isUbaInflow(flow)) {
      ({ balancingFee } = getDepositFee(flow.amount, runningBalance, incentiveBalance, flowChain, ubaConfigForChain));
    } else {
      ({ balancingFee } = getRefundFee(flow.amount, runningBalance, incentiveBalance, flowChain, ubaConfigForChain));
    }

    // Figure out the LP fee which is based only on the flow's origin and destination chain.
    const lpFee = computeLpFeeForRefresh(ubaConfigForChain.getBaselineFee(flow.destinationChainId, flow.originChainId));

    const newModifiedFlow: ModifiedUBAFlow = {
      flow,
      balancingFee,
      lpFee,
      runningBalance,
      incentiveBalance,
      netRunningBalanceAdjustment,
    };

    // Now we have all information we need to validate the flow:
    // If deposit, then flow is always valid:
    if (isUbaInflow(flow)) {
      return newModifiedFlow;
    } else {
      // Now we need to validate the refund or fill.

      // ASSUMPTION: the flow is already matched against a deposit by `getFlows` when comparing
      // all params besides `realizedLpFeePct`.

      // We need to make sure that the matched deposit is not a pre UBA deposit. Only pre UBA deposits
      // have defined realizedLpFeePct's at the time they are loaded in the flow.matchedDeposit
      // entry at this stage so they are trivial to validate.
      if (isDefined(flow.matchedDeposit.realizedLpFeePct)) {
        console.log("- Flow matched a pre-UBA deposit");
        // TODO: Potentially add additional safety check that we're identifying the matched deposit correctly as
        // a pre UBA deposit. If the deposit is not pre UBA but has a set realizedLpFeePct at this point
        // its a bug.

        // const hubStartBlock = this.hubPoolClient.getBundleStartBlockContainingBlock(flow.matchedDeposit.blockNumber, flow.matchedDeposit.originChainId);
        // isUBA(this.hubPoolClient.configStoreClient.getConfigStoreVersionForBlock(hubStartBlock))
        if (flow.matchedDeposit.realizedLpFeePct.eq(flow.realizedLpFeePct)) {
          // For pre UBA refund, the running balance should not be affected by this refund.
          // TODO: The above rule I think is arbitrary, we could decide to count these against
          // the running balances, but ideologically it doesn't make sense to me.
          const {
            runningBalance: precedingRunningBalance,
            incentiveBalance: precedingIncentiveBalance,
            netRunningBalanceAdjustment: precedingNetRunningBalanceAdjustment,
          } = analog.calculateHistoricalRunningBalance(
            precedingValidatedFlows.map(({ flow }) => flow),
            openingBalanceForChain.runningBalance,
            openingBalanceForChain.incentiveBalance,
            flowChain,
            tokenSymbol,
            ubaConfigForChain
          );
          return {
            flow,
            // Balancing fee for a pre UBA refund is 0
            balancingFee: ethers.constants.Zero,
            // Set realized LP fee for fill equal to the realized LP fee for the matched deposit.
            lpFee: flow.realizedLpFeePct,
            runningBalance: precedingRunningBalance,
            incentiveBalance: precedingIncentiveBalance,
            netRunningBalanceAdjustment: precedingNetRunningBalanceAdjustment,
          };
        } else {
          console.log("- Flow matched a pre-UBA deposit, but it was invalid because it set the wrong LP fee");
          return undefined;
        }
      }

      // Check the Timing Rule:
      // The fill must match with a deposit who's blockTimestamp is < fill.blockTimestamp.
      if (flow.blockTimestamp < flow.matchedDeposit.blockTimestamp) {
        // TODO: We cannot invalidate a fill if the latest block.timestamp on the deposit.origin chain is not > than the
        // the fill's timestamp. This is because its still possible to send a deposit on the origin chain
        // that would validate this fill.
        console.log("- Flow is invalid because its blockTimestamp is less than its matched deposit's blockTimestamp");
      } else {
        // Check the RealizedLpFeePct Rule:
        // Validate the fill.realizedLpFeePct against the expected matched deposit lpFee + balancingFee

        const matchedDeposit = flow.matchedDeposit;

        // We're going to try to identify the `matchedDepositFlow` which includes the balancing
        // fees and latest running balance for the matched deposit in its relevant bundle state.
        let matchedDepositFlow: ModifiedUBAFlow | undefined;

        // First, check if matched inflow is included in this current flow's bundle block range.
        // If its included here then we can exit early since the deposit must precede the flow
        // since flows are validated in chronological order by blockTimestamp.
        const matchedDepositBlockRangeInFlowBundle = getBlockRangeForChain(
          blockRangesContainingFlow,
          matchedDeposit.originChainId,
          this.chainIdIndices
        );

        // There are three cases:
        // 1. The matched deposit is in a bundle after the flow's bundle
        // 2. The matched deposit is in the same bundle as the flow's
        // 3. The matched deposit is in a bundle before the flow's bundle.
        if (matchedDeposit.blockNumber > matchedDepositBlockRangeInFlowBundle[1]) {
          // Its possible that a matched deposit is in a later bundle because of the way the dataworker constructs
          // bundle block ranges. This is possible if the fill is near the end of the previous bundle before the deposit
          // which is at the beginning.
          // We first try to check existing validated flows in the later bundle to see if we've already
          // validated this flow.
          const bundleForMatchedDeposit = this.getUbaBundleBlockRangeContainingFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId
          );
          console.log("- ➡️ Matched deposit bundle block range is after flow's", {
            bundleForMatchedDeposit,
          });
          matchedDepositFlow = this.getMatchingValidatedFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId,
            matchedDeposit,
            tokenSymbol
          );
          if (isDefined(matchedDepositFlow)) {
            console.log("- Found matched deposit in bundle after fill");
          } else {
            // We now need to recurse:
            console.log("- We need to recurse to validate the matched deposit, matched deposit bundle blocks:");
            const matchedDepositBundleFlows = await this.validateFlowsInBundle(bundleForMatchedDeposit, tokenSymbol);
            matchedDepositFlow = getMatchingFlow(
              matchedDepositBundleFlows[matchedDeposit.originChainId],
              matchedDeposit
            );
          }
        } else if (
          matchedDeposit.blockNumber >= matchedDepositBlockRangeInFlowBundle[0] &&
          matchedDeposit.blockNumber <= matchedDepositBlockRangeInFlowBundle[1]
        ) {
          // The matched deposit is in the same bundle as the flow. This is an easy case since we know the deposit
          // must have been validated already.
          console.log("- Matched deposit should be in same bundle as flow");
          const bundleKey = getBundleKeyForBlockRanges(blockRangesContainingFlow);
          const validatedFlowsOnOriginChain =
            this.validatedFlowsPerBundle[bundleKey][tokenSymbol][matchedDeposit.originChainId];
          matchedDepositFlow = getMatchingFlow(validatedFlowsOnOriginChain, matchedDeposit);
          if (!isDefined(matchedDepositFlow)) {
            throw new Error("Could not find matched deposit in same bundle as fill");
          } else {
            console.log("- Found matched deposit in same bundle as fill");
            return newModifiedFlow;
          }
        } else {
          // The bundle containing the matched deposit is older than current bundle range for flow.
          // We might need to recurse here if we haven't validated the deposit yet.
          const bundleForMatchedDeposit = this.getUbaBundleBlockRangeContainingFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId
          );
          console.log("- ⬅️ Matched deposit bundle block range is older than flow's", {
            bundleForMatchedDeposit,
          });
          matchedDepositFlow = this.getMatchingValidatedFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId,
            matchedDeposit,
            tokenSymbol
          );
          // If not found in cache, then we need to recurse and validate this bundle.
          if (!isDefined(matchedDepositFlow)) {
            console.log("- We need to recurse to validate the matched deposit, matched deposit bundle blocks:");
            const matchedDepositBundleFlows = await this.validateFlowsInBundle(bundleForMatchedDeposit, tokenSymbol);
            matchedDepositFlow = getMatchingFlow(
              matchedDepositBundleFlows[matchedDeposit.originChainId],
              matchedDeposit
            );
          }
        }

        // At this point we couldn't find a flow in the cache or from newly validated data that matches the
        // flow.matchedDeposit. This is unexpected and perhaps means we need to widen the spoke pool client lookback.
        if (!isDefined(matchedDepositFlow)) {
          throw new Error("Could not validate or invalidate matched deposit");
        }

        // Note: This will always be false when testing against pre UBA deposits on production networks.
        const expectedRealizedLpFeePctForMatchedDeposit = matchedDepositFlow.lpFee.add(matchedDepositFlow.balancingFee);
        // eslint-disable-next-line no-constant-condition
        if (true) {
          // Temporarily set to always true to test pre UBA deposits.
          // if (expectedRealizedLpFeePctForMatchedDeposit.eq(flow.realizedLpFeePct)) {
          return newModifiedFlow;
        } else {
          console.log(
            `- Matched deposit was validated by incorrect realized lp fee pct set for outflow, expected ${expectedRealizedLpFeePctForMatchedDeposit.toString()}`
          );
        }
      }
    }
    return undefined;
  }

  /**
   * Locates the bundle range containing the flow on the specified chain and then tries to return the matching
   * validated flow if it already exists in memory.
   * @param flowBlock
   * @param flowChain
   * @param flow
   * @returns
   */
  private getMatchingValidatedFlow(
    flowBlock: number,
    flowChain: number,
    flow: UbaFlow,
    tokenSymbol: string
  ): ModifiedUBAFlow | undefined {
    const bundleContainingFLow = this.getUbaBundleBlockRangeContainingFlow(flowBlock, flowChain);
    const bundleKey = getBundleKeyForBlockRanges(bundleContainingFLow);
    const validatedFlowsInBundle = this.validatedFlowsPerBundle?.[bundleKey]?.[tokenSymbol]?.[flowChain];
    const matchingFlow = getMatchingFlow(validatedFlowsInBundle, flow);
    return matchingFlow;
  }

  /**
   * Returns a convenient mapping of the most recent block ranges for each chain.
   * Assumption: For each chain, there should be the same number of block ranges returned.
   * Assumption: The block ranges for each chain should cover from the activation bundle start block
   * for the UBA until the latest block searched for the chain.
   * @param bundleCount Block ranges to fetch per chain
   * @returns A dictionary mapping chainId to an array of block ranges, where the ranges are arrays of length two
   *         and the first element is the start block and the second element is the end block.
   */
  private getMostRecentBundleBlockRangesPerChain(bundleCount: number): Record<number, number[][]> {
    // Load common data:
    const latestHubPoolBlock = this.hubPoolClient.latestBlockNumber;
    if (!isDefined(latestHubPoolBlock)) throw new Error("HubPoolClient not updated");

    return this.hubPoolClient.configStoreClient.enabledChainIds.reduce((acc, chainId) => {
      // Gets the most recent `bundleCount` block ranges for this chain.
      const _blockRangesForChain = getMostRecentBundleBlockRanges(
        chainId,
        bundleCount,
        latestHubPoolBlock,
        this.hubPoolClient,
        this.spokePoolClients
      ).map(({ start, end }) => [start, end]);
      // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
      // client was provided for the chain. In this case we assume that chain is disabled.
      if (isDefined(this.spokePoolClients[chainId])) {
        _blockRangesForChain[_blockRangesForChain.length - 1][1] = this.spokePoolClients[chainId].latestBlockSearched;
      }

      // Map the block ranges to this chain and move on to the next chain.
      acc[chainId] = _blockRangesForChain;
      return acc;
    }, {} as Record<number, number[][]>);
  }

  /**
   * Return the block range stored in this.ubaBundleBlockRanges that contains the flow.
   * @param flowBlock
   * @param flowChain
   * @returns
   */
  private getUbaBundleBlockRangeContainingFlow(flowBlock: number, flowChain: number): number[][] {
    const blockRangesContainingFlow = this.ubaBundleBlockRanges.find((blockRanges) => {
      const blockRangeForChain = getBlockRangeForChain(blockRanges, flowChain, this.chainIdIndices);
      return blockRangeForChain[0] <= flowBlock && flowBlock <= blockRangeForChain[1];
    });
    if (!blockRangesContainingFlow) {
      throw new Error("Could not find bundle block range containing flow");
    }
    return blockRangesContainingFlow;
  }

  /**
   * Updates the bundle state.
   */
  public async update(): Promise<void> {
    this.logger.debug({
      at: "UBAClientWithRefresh",
      message: "❤️‍🔥😭  Updating UBA Client",
    });

    // DEMO: limiting the tokens to test temporarily:
    const tokens = ["WETH", "USDC"];

    // Load all UBA bundle block ranges for each chain:
    const blockRangesByChain = this.getMostRecentBundleBlockRangesPerChain(100);
    const bundleBlockRangesCount = blockRangesByChain[this.chainIdIndices[0]].length;
    const bundleBlockRanges: number[][][] = [];
    for (let i = 0; i < bundleBlockRangesCount; i++) {
      bundleBlockRanges.push(
        this.chainIdIndices.map((chainId) => {
          return blockRangesByChain[chainId][i];
        })
      );
    }
    this.ubaBundleBlockRanges = bundleBlockRanges;
    console.log("UBA bundle block ranges we're storing in class memory", this.ubaBundleBlockRanges);

    // Demo: Limit loading state to only the most recent bundle. This will neccessarily load state
    // for older bundles as well...
    const newUbaClientState: UBAClientState = {};
    for (let i = this.ubaBundleBlockRanges.length - 1; i >= 0; i--) {
      const mostRecentBundleBlockRanges = this.ubaBundleBlockRanges[i];
      console.log("Validating flows for bundle", mostRecentBundleBlockRanges);
      await forEachAsync(tokens, async (token) => {
        // Validate flows, which should load them into memory.
        const modifiedFlowsInBundle = await this.validateFlowsInBundle(mostRecentBundleBlockRanges, token);

        // Load into UBA client state.
        this.chainIdIndices.map((chainId) => {
          if (!isDefined(newUbaClientState[chainId])) newUbaClientState[chainId] = {};
          if (!isDefined(newUbaClientState[chainId][token])) newUbaClientState[chainId][token] = [];
          newUbaClientState[chainId][token].push({
            bundleBlockRanges: mostRecentBundleBlockRanges,
            flows: modifiedFlowsInBundle[chainId],
          });
        });
      });
    }

    this.bundleStates = newUbaClientState;
    this.isUpdated = true;

    // Log bundle states in readable form.
    for (let i = 0; i < this.ubaBundleBlockRanges.length; i++) {
      tokens.forEach((token) => {
        const bundleBlockRange = this.ubaBundleBlockRanges[i];
        const breakdownPerChain = this.chainIdIndices
          .map((chainId) => {
            const bundleState = this.bundleStates[chainId]?.[token]?.[i];
            if (isDefined(bundleState)) {
              const { flows } = bundleState;
              const readableFlows = {
                fills: flows.filter(({ flow }) => isUbaOutflow(flow) && outflowIsFill(flow)).length,
                deposits: flows.filter(({ flow }) => isUbaInflow(flow)).length,
                refunds: flows.filter(({ flow }) => isUbaOutflow(flow) && outflowIsRefund(flow)).length,
              };
              return [chainId, readableFlows];
            } else return undefined;
          })
          .filter(isDefined);
        const breakdown = Object.fromEntries(breakdownPerChain);
        console.log(`Reading bundle state for ${token} for block ranges`, bundleBlockRange, breakdown);
      });
    }
    // Terminate process here so we can read these logs without getting flooded by dataworker logs.
    process.exit();
  }
}
