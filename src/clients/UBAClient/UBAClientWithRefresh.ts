import assert from "assert";
import winston from "winston";
import { SpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import {
  getBundleKeyForBlockRanges,
  getFlowChain,
  getUBAFlows,
  getMatchingFlow,
  getMostRecentBundleBlockRanges,
  getOpeningRunningBalanceForEvent,
  getUBAFeeConfig,
  getUbaActivationBundleStartBlocks,
  sortFlowsAscending,
} from "./UBAClientUtilities";
import { CachedUBABundleState, ModifiedUBAFlow, SystemFeeResult, UBAClientState } from "./UBAClientTypes";
import {
  CachingMechanismInterface,
  UbaFlow,
  UbaInflow,
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
  outflowIsRefund,
} from "../../interfaces";
import {
  blockRangesAreInvalidForSpokeClients,
  fixedPointAdjustment,
  forEachAsync,
  getBlockForChain,
  getBlockRangeForChain,
  isDefined,
  mapAsync,
  toBNWei,
} from "../../utils";
import { analog } from "../../UBAFeeCalculator";
import { getDepositFee, getRefundFee } from "../../UBAFeeCalculator/UBAFeeSpokeCalculatorAnalog";
import { BigNumber, ethers } from "ethers";
import { BaseAbstractClient } from "../BaseAbstractClient";
import UBAConfig from "../../UBAFeeCalculator/UBAFeeConfig";

/**
 * @notice This class reconstructs UBA bundle data for every bundle that has been created since the
 * UBA activation. Its performance can be signficantly sped up by integrating an external caching layer
 * like IPFS or Redis. It provides an interface that is designed to be called by actors who want to
 * to reconstruct a past bundle's state or validate a live bundle's state in order to evaluate a pending
 * root bundle, propose a new root bundle, or get the latest prices as a relayer or fee quoter.
 */
export class UBAClientWithRefresh extends BaseAbstractClient {
  // A public, convenient variable storing `ubaBundleStates` in a different format, with all bundle data
  // for a token and chain grouped together in a list.
  public ubaClientState: UBAClientState = {};

  // Associates a single bundle state with a unique key. The key should be created via
  // `this.getKeyForBundle(blockRanges, tokenSymbol, chain)`.
  // Bundle states from older, already validated, bundles should ideally be seeded directly
  // from an external storage layer rather than reconstructed fresh from this class. These state should
  // be populated for all block ranges where the UBA is active after calling update().
  public ubaBundleStates: Record<string, CachedUBABundleState> = {};

  // Chains we want to load new bundle data for.
  public enabledChainIds: number[];

  // Canonical chain ID indices mapping chains to bundle evaluation end blocks.
  public chainIdIndices: number[];

  // All bundle ranges loaded by this client. Should contain all bundle ranges for all validated bundles
  // as of the UBA activation block that the hub pool client is aware of. This is fast to load
  // since it only depends on HubPoolClient event history. These should be stores in chronologically
  // ascending order.
  public ubaBundleBlockRanges: number[][][] = [];

  public latestBlockTimestamps: Record<number, number> = {};

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
    public readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    protected readonly cachingClient?: CachingMechanismInterface
  ) {
    super();
    this.logger = this.hubPoolClient.logger;
    this.enabledChainIds = this.hubPoolClient.configStoreClient.getEnabledChains();
    assert(this.enabledChainIds.length > 0, "No chainIds provided");
    this.enabledChainIds.forEach((chainId) => {
      assert(isDefined(spokePoolClients[chainId]), `No SpokePool provided for chainId ${chainId}`);
    });
    this.chainIdIndices = this.hubPoolClient.configStoreClient.getChainIdIndicesForBlock();
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
  public computeFeesForDeposit(deposit: UbaInflow): SystemFeeResult {
    this.assertUpdated();

    const tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
    if (!tokenSymbol) throw new Error("No token symbol found");

    // Grab bundle state containing deposit using the bundle state's block ranges.
    const blockRangeContainingDeposit = this.getUbaBundleBlockRangeContainingFlow(
      deposit.blockNumber,
      deposit.originChainId
    );
    const specificBundleState = this.getBundleState(blockRangeContainingDeposit, tokenSymbol, deposit.originChainId);

    // Find matching flow in bundle state.
    const matchingFlow = getMatchingFlow(specificBundleState.flows, deposit);
    if (!matchingFlow) {
      throw new Error("Found bundle state containing flow but no matching flow found for deposit");
    }

    const lpFee = matchingFlow.lpFee.mul(deposit.amount).div(fixedPointAdjustment);
    const depositBalancingFee = matchingFlow.balancingFee;
    return {
      lpFee,
      depositBalancingFee,
      systemFee: lpFee.add(depositBalancingFee),
    };
  }

  /**
   * @notice Can be used by Relayer to approximate next refund balancing fees on refund chain. This is useful
   * for the relayer because they can only assume that their fill gets mined as the "next" fill on the destination
   * chain.
   * @dev Should work even if there are no validated flows or no bundle states yet.
   */
  public computeBalancingFeeForNextRefund(
    repaymentChainId: number,
    refundTokenSymbol: string,
    amount: BigNumber
  ): BigNumber {
    this.assertUpdated();

    // Grab latest flow to get the latest running balance on the desired refund chain for the desired token.
    const latestBlockRange = this.ubaBundleBlockRanges.at(-1);
    if (!latestBlockRange) {
      throw new Error("No block ranges stored, have you updated this client?");
    }

    const lastBundleState = this.getBundleState(latestBlockRange, refundTokenSymbol, repaymentChainId);

    let latestRunningBalance = ethers.constants.Zero;
    let latestIncentiveBalance = ethers.constants.Zero;
    // Load latest bundle config.
    const ubaConfigForBundle = lastBundleState.ubaConfig;
    // Check if there are any flows in this bundle state. If there are not, then we can assume that
    // running balances are 0.
    const lastFlow = lastBundleState.flows.at(-1);
    if (isDefined(lastFlow)) {
      // Compute the fees that would be charged if `amount` was filled by the caller and the fill was
      // slotted in next on this chain.
      const { runningBalance, incentiveBalance } = analog.calculateHistoricalRunningBalance(
        lastBundleState.flows.map(({ flow, balancingFee }) => {
          return {
            ...flow,
            incentiveFee: balancingFee,
          };
        }),
        lastFlow.runningBalance,
        lastFlow.incentiveBalance,
        lastFlow.netRunningBalanceAdjustment,
        repaymentChainId,
        refundTokenSymbol,
        ubaConfigForBundle
      );
      latestRunningBalance = runningBalance;
      latestIncentiveBalance = incentiveBalance;
    }

    const { balancingFee } = getRefundFee(
      amount,
      latestRunningBalance,
      latestIncentiveBalance,
      repaymentChainId,
      ubaConfigForBundle
    );
    return balancingFee;
  }

  /**
   * @notice Expected to be called by dataworker to reconstruct bundle roots using validated flow information
   * in bundle.
   */
  public getModifiedFlows(
    chainId: number,
    tokenSymbol: string,
    startBlock: number,
    endBlock: number
  ): ModifiedUBAFlow[] {
    this.assertUpdated();

    // Find the bundle block range that entirely contains start and end block
    const specificBundleRange = this.ubaBundleBlockRanges.find((blockRanges) => {
      const blockRangeForChain = getBlockRangeForChain(blockRanges, chainId, this.chainIdIndices);
      return blockRangeForChain[0] <= startBlock && blockRangeForChain[1] >= endBlock;
    });
    if (!isDefined(specificBundleRange)) {
      throw new Error(
        `Could not find bundle block range containing block range ${startBlock} to ${endBlock} on chain ${chainId}`
      );
    }
    const bundleState = this.getBundleState(specificBundleRange, tokenSymbol, chainId);
    return bundleState.flows.filter(({ flow }) => {
      flow.blockNumber <= endBlock && flow.blockNumber >= startBlock;
    });
  }

  public getKeyForBundle = (bundleBlockRanges: number[][], tokenSymbol: string, chainId: number): string => {
    // Add a fixed prefix to all keys so we can more easily flush all bundle state keys.
    return `UBA_BUNDLE_STATE_${getBundleKeyForBlockRanges(bundleBlockRanges)}-${tokenSymbol}-${chainId}`;
  };

  /**
   * Can be used by middleware API to refresh the latest bundle state for a given token and chain. The API
   * can serve this information and make it very fast to then compute the next deposit and refund balancing fees.
   * @param tokenSymbol
   * @param chainId
   * @returns
   */
  public getLatestBundleState(
    tokenSymbol: string,
    chainId: number
  ): {
    flows: ModifiedUBAFlow[];
    ubaConfig: UBAConfig;
  } {
    this.assertUpdated();

    const latestBlockRange = this.ubaBundleBlockRanges.at(-1);
    if (!latestBlockRange) {
      throw new Error("No block ranges stored, have you updated this client?");
    }

    const { flows, ubaConfig } = this.getBundleState(latestBlockRange, tokenSymbol, chainId);
    return {
      flows,
      ubaConfig,
    };
  }

  // /////////////////
  //
  //
  // PRIVATE METHODS:
  //
  // /////////////////

  /**
   * This client should only access the `ubaBundleStates` state via this function.
   */
  private getBundleState(blockRange: number[][], tokenSymbol: string, chainId: number): CachedUBABundleState {
    const key = this.getKeyForBundle(blockRange, tokenSymbol, chainId);
    const bundleState = this.ubaBundleStates[key];
    if (!isDefined(bundleState)) {
      throw new Error(
        `Bundle state for chain ${chainId}, token ${tokenSymbol} and block range ${blockRange} should exist`
      );
    }
    return bundleState;
  }

  /**
   * @notice Compute the LP fee for a given amount.
   */
  private computeLpFee(baselineFee: BigNumber) {
    // @dev Temporarily, the LP fee only comprises the baselineFee. In the future, a variable component will be
    // added to the baseline fee that takes into account the utilized liquidity in the system and how the the bridge
    // defined by { amount, originChain, refundChain, hubPoolBlock } affects that liquidity.
    return baselineFee;
  }

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
        return JSON.stringify(blockRanges) === JSON.stringify(bundleBlockRanges);
      })
    ) {
      throw new Error("Invalid block ranges not found in this.ubaBundleBlockRanges state");
    }

    // Load common data:
    const l1TokenAddress = this.hubPoolClient.getL1Tokens().find((token) => token.symbol === tokenSymbol)?.address;
    if (!l1TokenAddress) throw new Error(`No L1 token address found for token symbol ${tokenSymbol}`);

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
      this.enabledChainIds.map((chainId) => {
        return [chainId, getBlockRangeForChain(blockRanges, chainId, this.chainIdIndices)];
      })
    );

    // Combine flows from all chain block ranges in this bundle.
    const flowsInBundle = sortFlowsAscending(
      (
        await mapAsync(this.enabledChainIds, async (chainId) => {
          const [startBlock, endBlock] = blockRangesForChain[chainId];

          // Don't load flows for disabled block ranges in this bundle.
          if (startBlock === endBlock) {
            return [];
          }

          // TODO: Cache this result to make more performant.
          const flows = await getUBAFlows(
            tokenSymbol,
            chainId,
            this.spokePoolClients,
            this.hubPoolClient,
            startBlock,
            endBlock
          );

          // // Print out readable breakdown of flows.
          // const prettyFlows = flows.reduce(
          //   (acc, flow) => {
          //     if (isUbaOutflow(flow) && outflowIsFill(flow)) {
          //       acc.fills += 1;
          //     } else if (isUbaOutflow(flow) && outflowIsRefund(flow)) {
          //       acc.refunds += 1;
          //     } else {
          //       acc.deposits += 1;
          //     }
          //     return acc;
          //   },
          //   { fills: 0, refunds: 0, deposits: 0 }
          // );
          // this.logger.debug({
          //   at: "UBAClientWithRefresh#validateFlowsInBundle",
          //   message: `Flow breakdown for chain ${chainId} and token ${tokenSymbol}`,
          //   blockRangesForChain,
          //   prettyFlows
          // })
          return flows;
        })
      ).flat()
    );

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
      // const bundleKey = this.getKeyForBundle(blockRanges, tokenSymbol, flowChain);
      // console.group(`Trying to validate flow for chain ${flowChain} and key ${bundleKey}`, {
      //   isUbaInflow: isUbaInflow(flow),
      //   isUbaOutflow: isUbaOutflow(flow),
      //   flowChain,
      //   transactionhash: flow.transactionHash,
      //   amount: flow.amount,
      //   blockTimestamp: flow.blockTimestamp,
      //   blockNumber: flow.blockNumber,
      //   realizedLpFeePct: flow.realizedLpFeePct,
      //   matchedDeposit: (flow as UbaOutflow)?.matchedDeposit && {
      //     originChain: (flow as UbaOutflow).matchedDeposit.originChainId,
      //     transactionhash: (flow as UbaOutflow).matchedDeposit.transactionHash,
      //     blockTimestamp: (flow as UbaOutflow).matchedDeposit.blockTimestamp,
      //     blockNumber: (flow as UbaOutflow).matchedDeposit.blockNumber,
      //     // This should be defined only if its a pre UBA deposit.
      //     realizedLpFeePct: (flow as UbaOutflow).matchedDeposit?.realizedLpFeePct,
      //   },
      // });

      // Validate this flow and cache it if it is valid.
      // console.log(`- precedingValidatedFlows length: ${precedingValidatedFlows.length}`);
      const validatedFlow = await this.validateFlow(flow);

      if (isDefined(validatedFlow)) {
        // console.log("Validated ✅", {
        //   runningBalance: validatedFlow.runningBalance,
        //   incentiveBalance: validatedFlow.incentiveBalance.toString(),
        //   netRunningBalanceAdjustment: validatedFlow.netRunningBalanceAdjustment.toString(),
        //   balancingFee: validatedFlow.balancingFee.toString(),
        //   lpFee: validatedFlow.lpFee.toString(),
        // });
        this.appendValidatedFlowsToClassState(flowChain, tokenSymbol, [validatedFlow], blockRanges);
      } else {
        // this.logger.debug({
        //   at: "UBAClientWithRefresh#validateFlowsInBundle",
        //   message: `❌ Invalidated flow for chain ${flowChain} and token ${tokenSymbol}`,
        //   blockRanges: blockRangesForChain,
        //   flow
        // })
      }
      // console.groupEnd();
    }

    return Object.fromEntries(
      this.enabledChainIds.map((chainId) => {
        const bundleStateForChain = this.getBundleState(blockRanges, tokenSymbol, chainId);
        return [chainId, bundleStateForChain.flows];
      })
    );
  }

  /**
   * Return flow with computed fees if it is valid. Otherwise, return undefined. Inflows are always valid,
   * while outflows need to match against an inflow and have set the correct realizedLpFeePct
   * @param flow Flow to validate. It's assumed that flow is already matched with a deposit, if its an outflow.
   * @returns Validated flow or undefined if flow cannot be validated.
   */
  protected async validateFlow(flow: UbaFlow): Promise<ModifiedUBAFlow | undefined> {
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

    // Get opening balance and config at the start time of the bundle containing the flow. We basically want to grab
    // the latest validated bundle preceding the bundle containing the flow. This should have been
    // preloaded already into the memory state.
    const blockRangesContainingFlow = this.getUbaBundleBlockRangeContainingFlow(flow.blockNumber, flowChain);
    const bundleSharedState = this.getBundleState(blockRangesContainingFlow, tokenSymbol, flowChain);
    const openingBalanceForChain = bundleSharedState.openingBalances;
    const ubaConfigForChain = bundleSharedState.ubaConfig;
    // const runningBalanceThresholds = ubaConfigForChain.getBalanceTriggerThreshold(flowChain, tokenSymbol);
    // console.log("- Bundle information for flow", {
    //   blockRangesContainingFlow,
    //   openingBalanceForChain,
    //   ubaConfigBaselineFeeCurve: ubaConfigForChain
    //     .getBaselineFee(flow.destinationChainId, flow.originChainId)
    //     .toString(),
    //   upperRunningBalanceThresholds: {
    //     target: runningBalanceThresholds.upperBound?.target?.toString(),
    //     threshold: runningBalanceThresholds.upperBound?.threshold?.toString(),
    //   },
    //   lowerRunningBalanceThresholds: {
    //     target: runningBalanceThresholds.lowerBound?.target?.toString(),
    //     threshold: runningBalanceThresholds.lowerBound?.threshold?.toString(),
    //   },
    // });

    // Use the opening balance to compute expected flow fees:
    const precedingValidatedFlows = bundleSharedState.flows;
    const lastFlow = precedingValidatedFlows[precedingValidatedFlows.length - 1];
    const latestRunningBalance = lastFlow?.runningBalance ?? openingBalanceForChain.runningBalance;
    const latestIncentiveBalance = lastFlow?.incentiveBalance ?? openingBalanceForChain.incentiveBalance;
    const latestNetRunningBalanceAdjustment = lastFlow?.netRunningBalanceAdjustment ?? ethers.constants.Zero;
    let potentialBalancingFee: BigNumber;
    if (isUbaInflow(flow)) {
      ({ balancingFee: potentialBalancingFee } = getDepositFee(
        flow.amount,
        latestRunningBalance,
        latestIncentiveBalance,
        flowChain,
        ubaConfigForChain
      ));
    } else {
      ({ balancingFee: potentialBalancingFee } = getRefundFee(
        flow.amount,
        latestRunningBalance,
        latestIncentiveBalance,
        flowChain,
        ubaConfigForChain
      ));
    }
    // console.log("- Potential balancing fee for flow", potentialBalancingFee.toString());

    // Figure out the running balance so far for this flow's chain. This is based on all already validated flows
    // for this chain plus the current flow assuming it is valid.
    const { runningBalance, incentiveBalance, netRunningBalanceAdjustment } = analog.calculateHistoricalRunningBalance(
      [
        {
          ...flow,
          incentiveFee: potentialBalancingFee,
        },
      ],
      latestRunningBalance,
      latestIncentiveBalance,
      latestNetRunningBalanceAdjustment,
      flowChain,
      tokenSymbol,
      ubaConfigForChain
    );

    // Figure out the LP fee which is based only on the flow's origin and destination chain.
    const lpFeePct = this.computeLpFee(ubaConfigForChain.getBaselineFee(flow.destinationChainId, flow.originChainId));
    const lpFee = lpFeePct.mul(flow.amount).div(fixedPointAdjustment);

    const newModifiedFlow: ModifiedUBAFlow = {
      flow,
      balancingFee: potentialBalancingFee,
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
      if (!isDefined(flow.realizedLpFeePct)) {
        throw new Error("Outflow has undefined realizedLpFeePct");
      }

      // ASSUMPTION: the flow is already matched against a deposit by `getUBAFlows` when comparing
      // all params besides `realizedLpFeePct`.

      // We need to make sure that the matched deposit is not a pre UBA deposit. Only pre UBA deposits
      // have defined realizedLpFeePct's at the time they are loaded in the flow.matchedDeposit
      // entry at this stage so they are trivial to validate.
      if (isDefined(flow.matchedDeposit.realizedLpFeePct)) {
        // console.log("- Flow matched a pre-UBA deposit");
        // TODO: Potentially add additional safety check that we're identifying the matched deposit correctly as
        // a pre UBA deposit. If the deposit is not pre UBA but has a set realizedLpFeePct at this point
        // its a bug.

        if (flow.matchedDeposit.realizedLpFeePct.eq(flow.realizedLpFeePct)) {
          // If flow matched with a pre UBA deposit then the flow should accrue no balancing fees and not impact
          // running balances so we should use the running balances from before the flow.
          return {
            flow,
            runningBalance: latestRunningBalance,
            incentiveBalance: latestIncentiveBalance,
            netRunningBalanceAdjustment: latestNetRunningBalanceAdjustment,
            // Balancing fee for a pre UBA refund is 0
            balancingFee: ethers.constants.Zero,
            // Set realized LP fee for fill equal to the realized LP fee for the matched deposit.
            lpFee: flow.realizedLpFeePct.mul(flow.amount).div(fixedPointAdjustment),
          };
        } else {
          this.logger.debug({
            at: "UBAClientWithRefresh#validateFlow",
            message: "Flow matched a pre-UBA deposit, but it was invalid because it set the wrong LP fee",
            flow,
          });
          return undefined;
        }
      }

      // This is a clever optimization we can make and exit early: If the UBA config
      // at the time of the matched deposit has a flat balancing fee, then its realizedLpFeePct only depends
      // on the lpFee component as we can assume the balancing fee was 0 regardless of the running
      // balance at the time of the deposit flow.
      // I *think* (with a lot of uncertainty) we should put this before the timing rule so that we can take advantage of this rule to overcome
      // chain haltings where a chain's blockTimestamps stops progressing?
      const matchedDeposit = flow.matchedDeposit;
      const bundleForMatchedDeposit = this.getUbaBundleBlockRangeContainingFlow(
        matchedDeposit.blockNumber,
        matchedDeposit.originChainId
      );
      const depositBundleState = this.getBundleState(
        bundleForMatchedDeposit,
        tokenSymbol,
        matchedDeposit.originChainId
      );
      const ubaConfigForDeposit = depositBundleState.ubaConfig;
      if (ubaConfigForDeposit.isBalancingFeeCurveFlatAtZero(flow.matchedDeposit.originChainId)) {
        // console.log("- Flow matched a deposit on a chain with a flat balancing fee curve at 0");
        const lpFeePct = newModifiedFlow.lpFee.mul(fixedPointAdjustment).div(flow.amount);
        if (!lpFeePct.eq(flow.realizedLpFeePct as BigNumber)) {
          // this.logger.debug({
          //   at: "UBAClientWithRefresh#validateFlow",
          //   message: `Flow matched a deposit on a chain with a flat balancing fee curve at 0, but it was invalid because it set the wrong LP fee`,
          //   expected: lpFeePct.toString(),
          //   flow
          // })
          return undefined;
        } else {
          return newModifiedFlow;
        }
      }

      // Check the Timing Rule:
      // The fill must match with a deposit who's blockTimestamp is < fill.blockTimestamp.
      if (flow.blockTimestamp < flow.matchedDeposit.blockTimestamp) {
        // We cannot invalidate a fill if the latest block.timestamp on the deposit.origin chain is not > than the
        // the fill's timestamp. This is because its still possible to send a deposit on the origin chain
        // that would validate this fill.
        // TODO: Figure out how to handle this without crashing.
        if (this.latestBlockTimestamps[flow.matchedDeposit.originChainId] < flow.blockTimestamp) {
          this.logger.error({
            at: "UBAClientWithRefresh#validateFlow",
            message:
              "We cannot invalidate a fill if the latest block.timestamp on the origin chain is <= the fill's timestamp",
            latestOriginChainBlockTimestamp: this.latestBlockTimestamps[flow.matchedDeposit.originChainId],
            flow,
          });
          throw new Error(
            `We cannot invalidate a fill if the latest block.timestamp ${
              this.latestBlockTimestamps[flow.matchedDeposit.originChainId]
            } on the deposit.origin chain is not > than the fill's timestamp ${
              flow.blockTimestamp
            }. This is because its still possible to send a deposit on the origin chain that would validate this fill.`
          );
        }
      } else {
        // Check the RealizedLpFeePct Rule:
        // Validate the fill.realizedLpFeePct against the expected matched deposit lpFee + balancingFee

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
          // console.log("- ➡️ Matched deposit bundle block range is after flow's", {
          //   bundleForMatchedDeposit,
          // });
          matchedDepositFlow = this.getMatchingValidatedFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId,
            matchedDeposit,
            tokenSymbol
          );
          if (isDefined(matchedDepositFlow)) {
            // console.log("- Found matched deposit in bundle after fill");
          } else {
            // We now need to recurse:
            // console.log("- We need to recurse to validate the matched deposit, matched deposit bundle blocks:");
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
          // The matched deposit is in the same bundle as the flow.
          // console.log("- Matched deposit should be in same bundle as flow");
          const validatedFlowsOnOriginChain = depositBundleState.flows;
          matchedDepositFlow = getMatchingFlow(validatedFlowsOnOriginChain, matchedDeposit);
          if (!isDefined(matchedDepositFlow)) {
            this.logger.error({
              at: "UBAClientWithRefresh#validateFlow",
              message: "Deposit should be in same bundle as flow and already have been validated but cannot be found",
              validatedFlowsOnOriginChain,
              flow,
            });
            throw new Error("Could not find matched deposit in same bundle as fill");
          }
          // console.log("- Found matched deposit in same bundle as fill");
        } else {
          // The bundle containing the matched deposit is older than current bundle range for flow.
          // We might need to recurse here if we haven't validated the deposit yet.
          // console.log("- ⬅️ Matched deposit bundle block range is older than flow's", {
          //   bundleForMatchedDeposit,
          // });
          matchedDepositFlow = this.getMatchingValidatedFlow(
            matchedDeposit.blockNumber,
            matchedDeposit.originChainId,
            matchedDeposit,
            tokenSymbol
          );
          // If not found in cache, then we need to recurse and validate this bundle.
          if (!isDefined(matchedDepositFlow)) {
            // console.log("- We need to recurse to validate the matched deposit, matched deposit bundle blocks:");
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
          this.logger.error({
            at: "UBAClientWithRefresh#validateFlow",
            message: "No matching flow found in client state for matched deposit",
            flow,
          });
          throw new Error("Could not validate or invalidate matched deposit");
        }

        // Note: This will always be false when testing against pre UBA deposits on production networks.
        const expectedRealizedLpFeeForMatchedDeposit = matchedDepositFlow.lpFee.add(matchedDepositFlow.balancingFee);
        const expectedRealizedLpFeePctForMatchedDeposit = expectedRealizedLpFeeForMatchedDeposit
          .mul(fixedPointAdjustment)
          .div(matchedDepositFlow.flow.amount);
        // console.log(
        //   `- Expected realized lp fee pct for matched deposit: ${expectedRealizedLpFeePctForMatchedDeposit.toString()}, actual: ${flow.realizedLpFeePct?.toString()}`
        // );
        // We allow for some precision loss because of the way we compute balancing fees. The balancing fee curves are integrated
        // by computePiecewiseLinearFunction and they return values, so we set balancing fees equal to those values divided by
        // flow amounts, which produces precision loss.
        if (
          expectedRealizedLpFeePctForMatchedDeposit.lte(
            flow.realizedLpFeePct.mul(toBNWei("1.01")).div(fixedPointAdjustment)
          ) ||
          expectedRealizedLpFeePctForMatchedDeposit.gte(
            flow.realizedLpFeePct.mul(toBNWei("0.99")).div(fixedPointAdjustment)
          )
        ) {
          return newModifiedFlow;
        } else {
          // this.logger.debug({
          //   at: "UBAClientWithRefresh#validateFlow",
          //   message: `Matched deposit was invalidated by incorrect realized lp fee pct set for outflow`,
          //   expected: expectedRealizedLpFeePctForMatchedDeposit.toString(),
          //   matchedDepositFlow,
          //   flow,
          // })
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
    const bundleContainingFlow = this.getUbaBundleBlockRangeContainingFlow(flowBlock, flowChain);
    const validatedFlowsInBundle = this.getBundleState(bundleContainingFlow, tokenSymbol, flowChain).flows;
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
    return this.chainIdIndices.reduce((acc, chainId) => {
      // Gets the most recent `bundleCount` block ranges for this chain.
      const _blockRangesForChain = getMostRecentBundleBlockRanges(
        chainId,
        bundleCount,
        this.hubPoolClient,
        this.spokePoolClients
      ).map(({ start, end }) => [start, end]);

      // Sanity check that block ranges cover from UBA activation bundle start block for chain to latest spoke pool
      // client block searched:
      const ubaActivationBundleStartBlockForChain = getBlockForChain(
        getUbaActivationBundleStartBlocks(this.hubPoolClient),
        chainId,
        this.chainIdIndices
      );
      if (_blockRangesForChain.length === 0) {
        throw new Error(`Should never return 0 length block ranges for chain ${chainId}`);
      }
      if (
        // Check 1: start block of first block range should be equal to UBA activation bundle start block for chain
        _blockRangesForChain[0][0] !== ubaActivationBundleStartBlockForChain ||
        // Check 2: end block of last block range should be equal to latest spoke pool client block searched
        (isDefined(this.spokePoolClients[chainId]) &&
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          _blockRangesForChain.at(-1)![1] !== this.spokePoolClients[chainId].latestBlockSearched)
      ) {
        this.logger.error({
          at: "UBAClientWithRefresh#getMostRecentBundleBlockRangesPerChain",
          message: `Block ranges for chain ${chainId} do not cover from UBA activation bundle start block to latest spoke pool client block searched`,
          startBlockForChain: _blockRangesForChain[0][0],
          ubaActivationBundleStartBlockForChain,
          endBlockForChain: _blockRangesForChain.at(-1)?.[1],
          latestSpokePoolClientBlockSearched: this.spokePoolClients[chainId]?.latestBlockSearched,
        });
        throw new Error(
          `Block ranges for chain ${chainId} do not cover from UBA activation bundle start block to latest spoke pool client block searched`
        );
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
      throw new Error(`Could not find bundle block range containing flow at block ${flowBlock} on chain ${flowChain}`);
    }
    return blockRangesContainingFlow;
  }

  /**
   * This client should only update the `ubaBundleStates` state via this function.
   */
  private appendValidatedFlowsToClassState(
    chainId: number,
    tokenSymbol: string,
    flows: ModifiedUBAFlow[],
    bundleBlockRanges: number[][]
  ) {
    const bundleState = this.getBundleState(bundleBlockRanges, tokenSymbol, chainId);
    bundleState.flows.push(...flows);
  }

  /**
   * Updates the bundle state.
   */
  public async update(): Promise<void> {
    const latestHubPoolBlock = this.hubPoolClient.latestBlockNumber;
    if (!isDefined(latestHubPoolBlock)) throw new Error("HubPoolClient not updated");

    this.logger.debug({
      at: "UBAClientWithRefresh",
      message: "❤️‍🔥😭  Updating UBA Client",
      enabledChains: this.enabledChainIds,
    });

    const tokens = this.tokens;

    // Load all UBA bundle block ranges for each chain:
    this.logger.debug({
      at: "UBAClientWithRefresh#getMostRecentBundleBlockRangesPerChain",
      message: "Loaded UBA bundle start blocks",
      ubaActivationBundleStartBlockForChain: getUbaActivationBundleStartBlocks(this.hubPoolClient),
    });
    const blockRangesByChain = this.getMostRecentBundleBlockRangesPerChain(100);

    // Mainnet will always be the first chain in the chainIdIndices array and it will never have disabled
    // or missing block
    const bundleBlockRangesCount = blockRangesByChain[this.chainIdIndices[0]].length;
    const bundleBlockRanges: number[][][] = [];
    for (let i = 0; i < bundleBlockRangesCount; i++) {
      bundleBlockRanges.push(
        this.chainIdIndices
          .map((chainId) => {
            // If chain has exactly one bundle, which is possible if the chain was recently
            // added to the chain ID list, then fill block ranges with zero length ranges.
            const blockRangeCountForChain = blockRangesByChain[chainId].length;
            if (blockRangeCountForChain === 1) {
              const firstBlockRange = blockRangesByChain[chainId][0];
              // If chain is missing block ranges, fill the first few ranges for it with zero block ranges
              // that start and end at the first block range for the chain's start block.
              if (i < bundleBlockRangesCount - blockRangeCountForChain) {
                return [firstBlockRange[0], firstBlockRange[0]];
              } else {
                return firstBlockRange;
              }
            }
            return blockRangesByChain[chainId][i];
          })
          .filter(isDefined)
      );
    }

    // Validate that block ranges are equal length for all bundles.
    if (bundleBlockRanges.some((blockRange) => blockRange.length !== this.chainIdIndices.length)) {
      throw new Error("Block ranges are not equal length for all bundles");
    }
    this.ubaBundleBlockRanges = bundleBlockRanges;
    this.logger.debug({
      at: "UBAClientWithRefresh#update",
      message: "UBA bundle block ranges we're storing in class memory",
      bundleBlockRanges: this.ubaBundleBlockRanges,
    });

    // Pre-load bundle configs and opening balances for each chain and token per bundle range.
    // This also instantiates the ubaBundleStates class dictionary.
    for (let i = 0; i < this.ubaBundleBlockRanges.length; i++) {
      const bundleBlockRange = this.ubaBundleBlockRanges[i];
      const startBlocks = bundleBlockRange.map(([start]) => start);
      const mainnetStartBlock = getBlockForChain(startBlocks, this.hubPoolClient.chainId, this.chainIdIndices);
      tokens.forEach((token) => {
        const l1TokenAddress = this.hubPoolClient.getL1Tokens().find((_token) => _token.symbol === token)?.address;
        if (!isDefined(l1TokenAddress)) throw new Error(`No L1 token address found for token symbol ${token}`);
        this.enabledChainIds.forEach((chainId) => {
          const bundleStateKey = this.getKeyForBundle(bundleBlockRange, token, chainId);
          const startBlock = getBlockForChain(startBlocks, chainId, this.chainIdIndices);
          const openingBalances = getOpeningRunningBalanceForEvent(
            this.hubPoolClient,
            // Pass in a start block for the bundle containing the flow to this function so we always
            // get a running balance from the last validated bundle before this flow's bundle.
            startBlock,
            chainId,
            l1TokenAddress,
            latestHubPoolBlock
          );
          // console.log(
          //   `Setting running balance ${openingBalances.runningBalance.toString()} for bundle range ${bundleStateKey}}`
          // );
          const ubaConfig = getUBAFeeConfig(this.hubPoolClient, chainId, token, mainnetStartBlock);
          this.ubaBundleStates[bundleStateKey] = {
            openingBalances,
            ubaConfig,
            flows: [],
            loadedFromCache: false,
          };
        });
      });
    }

    // Load latest timestamps per chain:
    const latestTimestampsPerChain = Object.fromEntries(
      this.enabledChainIds
        .map((chainId) => {
          if (!isDefined(this.spokePoolClients[chainId])) return undefined;
          return [chainId, this.spokePoolClients[chainId].getCurrentTime()];
        })
        .filter(isDefined)
    );
    this.latestBlockTimestamps = latestTimestampsPerChain;
    this.logger.debug({
      at: "UBAClientWithRefresh#update",
      message: "Latest block timestamps per chain",
      latestBlockTimestamps: this.latestBlockTimestamps,
    });

    // First try to load bundle states from redis into memory to make the validateFlowsInBundle call significantly faster:
    if (isDefined(this.cachingClient)) {
      for (let i = this.ubaBundleBlockRanges.length - 1; i >= 0; i--) {
        const mostRecentBundleBlockRanges = this.ubaBundleBlockRanges[i];
        await forEachAsync(tokens, async (token) => {
          await forEachAsync(this.enabledChainIds, async (chainId) => {
            const redisKeyForBundle = this.getKeyForBundle(mostRecentBundleBlockRanges, token, chainId);
            const modifiedFlowsInBundle: ModifiedUBAFlow[] | undefined | null = await this.cachingClient?.get(
              redisKeyForBundle
            );
            if (isDefined(modifiedFlowsInBundle)) {
              // console.log(`💿 Loaded bundle state from cache using key ${redisKeyForBundle}`);
              this.appendValidatedFlowsToClassState(chainId, token, modifiedFlowsInBundle, mostRecentBundleBlockRanges);

              // Mark as loaded from cache.
              this.getBundleState(mostRecentBundleBlockRanges, token, chainId).loadedFromCache = true;
            } else {
              // console.log(`No entry for key ${redisKeyForBundle} in redis`);
            }
          });
        });
      }
    }

    // Validate flows for each token and chain inside a bundle, for all bundle block ranges in order.
    const newUbaClientState: UBAClientState = {};
    for (let i = 0; i < this.ubaBundleBlockRanges.length; i++) {
      const mostRecentBundleBlockRanges = this.ubaBundleBlockRanges[i];
      // console.log("Validating flows for bundle", mostRecentBundleBlockRanges);
      await forEachAsync(tokens, async (token) => {
        let modifiedFlowsInBundle: Record<number, ModifiedUBAFlow[]>;

        // We can skip the next step if we've already loaded flows for all chains from the cache:
        if (
          this.enabledChainIds.every((chainId) => {
            return this.getBundleState(mostRecentBundleBlockRanges, token, chainId).loadedFromCache;
          })
        ) {
          // const bundleKeyForBlockRanges = getBundleKeyForBlockRanges(mostRecentBundleBlockRanges);
          // console.log(
          //   `- Skipping validation for bundle ${bundleKeyForBlockRanges} for token ${token} because flows for all chains are already cached`
          // );
          modifiedFlowsInBundle = Object.fromEntries(
            this.enabledChainIds.map((chainId) => {
              const cachedFlows = this.getBundleState(mostRecentBundleBlockRanges, token, chainId).flows;
              return [chainId, cachedFlows];
            })
          );
        } else {
          // Validate flows, which should load them into memory. This is a big expensive function especially
          // if we haven't loaded any data from the cache and a lot of time has passed since the UBA activation
          // bundle!
          modifiedFlowsInBundle = await this.validateFlowsInBundle(mostRecentBundleBlockRanges, token);
        }

        // Save into UBA client state
        await forEachAsync(this.enabledChainIds, async (chainId) => {
          if (!isDefined(newUbaClientState[chainId])) newUbaClientState[chainId] = {};
          if (!isDefined(newUbaClientState[chainId][token])) newUbaClientState[chainId][token] = [];
          const bundleState = this.getBundleState(mostRecentBundleBlockRanges, token, chainId);
          newUbaClientState[chainId][token].push({
            bundleBlockRanges: mostRecentBundleBlockRanges,
            flows: bundleState.flows,
            ubaConfig: bundleState.ubaConfig,
            openingBalances: bundleState.openingBalances,
          });

          // We shouldn't cache the latest bundle state as it will always be unexecuted (i.e. its still
          // pending the challenge period or its leaves haven't been fully executed).
          // Moreover, we shouldn't cache bundles until we've seen a minimum number of bundles executed since UBA
          // genesis for safety reasons as this logic won't have been well tested until then.
          if (this.ubaBundleBlockRanges.length <= 30) return; // TODO: Remove this line once we feel comfortable
          // with caching bundles.
          if (i === this.ubaBundleBlockRanges.length - 1) return;
          const redisKeyForBundle = this.getKeyForBundle(mostRecentBundleBlockRanges, token, chainId);
          // console.log(`- Storing new bundle state under key ${redisKeyForBundle}`);
          // Note, we opt to store arrays as strings in redis rather than using the redis.json module because
          // we don't plan to manipulate the data inside redis, so we really only want to optimize for writing
          // and reading. The redis.json module is more performant for manipulating data while inside redis.
          if (isDefined(this.cachingClient)) {
            await this.cachingClient.set(
              redisKeyForBundle,
              modifiedFlowsInBundle[chainId]
              // I don't think we want these keys to expire since we'll likely always need data from the beginning
              // of the UBA activation block to validate even the latest bundles, because of the recursive nature
              // of how we compute running balances as a function of all prior validated bundle history.
            );
          }
        });
      });
    }

    // For each validated outflow, update its matched deposit's realizedLpFeePct in the spoke pool client:
    for (let i = 0; i < this.ubaBundleBlockRanges.length; i++) {
      const mostRecentBundleBlockRanges = this.ubaBundleBlockRanges[i];
      this.enabledChainIds.forEach((chainId) => {
        tokens.forEach((token) => {
          const modifiedFlowsInBundle = this.getBundleState(mostRecentBundleBlockRanges, token, chainId).flows;
          modifiedFlowsInBundle.forEach(({ flow }) => {
            // We can now set the realizedLpFeePct for the deposit in the SpokePoolClient, which was not
            // known to the SpokePoolClient at the time it queried the deposit.
            if (isUbaOutflow(flow) && !isDefined(flow.matchedDeposit.realizedLpFeePct)) {
              this.spokePoolClients[flow.matchedDeposit.originChainId].updateDepositRealizedLpFeePct(
                flow.matchedDeposit,
                flow.realizedLpFeePct
              );
            }
          });
        });
      });
    }

    // At last, load into ubaClientState. This way the caller now can access bundle states two ways:
    // via ubaCientState or via ubaBundleState.
    this.ubaClientState = newUbaClientState;
    this.isUpdated = true;

    // Log bundle states in readable form and check outputs:
    for (let i = 0; i < this.ubaBundleBlockRanges.length; i++) {
      tokens.forEach((token) => {
        const bundleBlockRange = this.ubaBundleBlockRanges[i];
        const breakdownPerChain = this.enabledChainIds
          .map((chainId) => {
            const bundleState = this.getBundleState(bundleBlockRange, token, chainId);
            if (isDefined(bundleState)) {
              const { flows } = bundleState;
              const lastFlow = flows.at(-1);
              if (!isDefined(lastFlow)) return undefined;

              // Filter out outflows matched with pre UBA deposits from the list
              const fills = flows.filter(
                ({ flow }) =>
                  isUbaOutflow(flow) && outflowIsFill(flow) && flow.matchedDeposit.realizedLpFeePct === undefined
              );
              const deposits = flows.filter(({ flow }) => isUbaInflow(flow));
              const refunds = flows.filter(
                ({ flow }) =>
                  isUbaOutflow(flow) && outflowIsRefund(flow) && flow.matchedDeposit.realizedLpFeePct === undefined
              );

              const inflows = deposits.reduce((sum, { flow }) => {
                sum = sum.add(flow.amount);
                return sum;
              }, ethers.constants.Zero);
              const fillOutflows = fills.reduce((sum, { flow }) => {
                sum = sum.add(flow.amount);
                return sum;
              }, ethers.constants.Zero);
              const refundOutflows = flows.reduce((sum, { balancingFee }) => {
                return sum.add(balancingFee);
              }, ethers.constants.Zero);
              const balancingFees = flows.reduce((sum, { balancingFee }) => {
                return sum.add(balancingFee);
              }, ethers.constants.Zero);
              const readableFlows = {
                fills: fills.length,
                fillRunningBalanceRemoved: fillOutflows.mul(-1).toString(),
                deposits: deposits.length,
                depositRunningBalanceAdded: inflows.toString(),
                refunds: refunds.length,
                refundRunningBalanceRemoved: refundOutflows.mul(-1).toString(),
                balancingFeesAdded: balancingFees.toString(),
                lpFeesAdded: flows
                  .reduce((sum, { lpFee }) => {
                    return sum.add(lpFee);
                  }, ethers.constants.Zero)
                  .toString(),
                netRunningBalanceAdjustment: lastFlow.netRunningBalanceAdjustment.toString(),
                openingRunningBalance: bundleState.openingBalances.runningBalance.toString(),
                closingRunningBalance: lastFlow.runningBalance.toString(),
                openingIncentiveBalance: bundleState.openingBalances.incentiveBalance.toString(),
                closingIncentiveBalance: lastFlow.incentiveBalance.toString(),
              };

              // Sanity check:
              // - opening running balance minus outflows plus inflows minus balancing fees plus net running balance adjustments = closing running balance
              const expectedClosingBalance = bundleState.openingBalances.runningBalance
                .add(inflows)
                .sub(refundOutflows)
                .sub(fillOutflows)
                .sub(balancingFees)
                .add(lastFlow.netRunningBalanceAdjustment);
              if (!expectedClosingBalance.eq(lastFlow.runningBalance)) {
                this.logger.error({
                  at: "UBAClientWithRefresh#update",
                  message: `Expected closing balance ${expectedClosingBalance.toString()} to equal actual closing balance ${lastFlow.runningBalance.toString()}`,
                  bundleBlockRange,
                  chainId,
                  token,
                  openingRunningBalance: bundleState.openingBalances.runningBalance.toString(),
                  inflows: inflows.toString(),
                  fillOutflows: fillOutflows.mul(-1).toString(),
                  refundOutflows: refundOutflows.mul(-1).toString(),
                  balancingFees: balancingFees.mul(-1).toString(),
                  netRunningBalanceAdjustment: lastFlow.netRunningBalanceAdjustment.toString(),
                });
              }
              return [chainId, readableFlows];
            } else return undefined;
          })
          .filter(isDefined);
        const breakdown = Object.fromEntries(breakdownPerChain);
        this.logger.debug({
          at: "UBAClientWithRefresh#update",
          message: `Bundle state for ${token}`,
          bundleBlockRange,
          breakdown,
        });
      });
    }
  }
}
