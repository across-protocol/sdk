import winston from "winston";
import { UbaFlow } from "../../interfaces";
import { BigNumber, ethers } from "ethers";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import { BalancingFeeReturnType, UBABundleState, UBAClientState, ModifiedUBAFlow } from "./UBAClientTypes";
import { findLast } from "../../utils/ArrayUtils";
import { analog } from "../../UBAFeeCalculator";
import { BaseAbstractClient } from "../BaseAbstractClient";
import _ from "lodash";

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * This class is not intended to be used directly, but rather extended by other classes that implement the abstract methods.
 */
export class BaseUBAClient extends BaseAbstractClient {
  /**
   * A mapping of Token Symbols to a mapping of ChainIds to a list of bundle states.
   * @note The bundle states are sorted in ascending order by block number.
   */
  protected bundleStates: UBAClientState;

  /**
   * Constructs a new UBAClientBase instance
   * @param chainIdIndices All ID indices as they appear in the contracts
   * @param tokens A list of all tokens that the UBA functionality should be implemented for
   * @param maxBundleStates The maximum number of bundle states to keep in memory
   * @param hubChainId The chainId of the hub chain
   * @param logger An optional logger to use for logging
   */
  constructor(
    protected readonly chainIdIndices: number[],
    protected readonly tokens: string[],
    protected readonly maxBundleStates: number,
    protected readonly hubChainId: number,
    protected readonly logger?: winston.Logger
  ) {
    super();
    this.bundleStates = {};
  }

  /**
   * Resolves the array of bundle states for a given token on a given chainId
   * @param chainId The chainId to get the bundle states for
   * @param tokenSymbol The token to get the bundle states for
   * @returns The array of bundle states for the given token on the given chainId if it exists, otherwise an empty array
   */
  public retrieveBundleStates(chainId: number, tokenSymbol: string): UBABundleState[] {
    return this.bundleStates?.[chainId]?.bundles?.[tokenSymbol] ?? [];
  }

  /**
   * Resolves the last bundle state for a given token on a given chainId
   * @param chainId The chainId to get the last bundle state for
   * @param tokenSymbol The token to get the last bundle state for
   * @returns The last bundle state for the given token on the given chainId if it exists, otherwise undefined
   */
  public retrieveLastBundleState(chainId: number, tokenSymbol: string): UBABundleState | undefined {
    return this.retrieveBundleStates(chainId, tokenSymbol).at(-1);
  }

  /**
   * Returns the most recent bundle state for a chain and token that was created before a given block number.
   * @param hubPoolBlockNumber The bundle state was proposed at or before this block
   * @param chainId
   * @param tokenSymbol
   * @returns the most recent bundle state for a given chain and token combination prior to the given block number.
   */
  public retrieveBundleStateForBlock(
    hubPoolBlockNumber: number,
    chainId: number,
    tokenSymbol: string
  ): UBABundleState | undefined {
    return _.findLast(
      this.retrieveBundleStates(chainId, tokenSymbol),
      (bundleState: UBABundleState) => bundleState.openingBlockNumberForSpokeChain <= hubPoolBlockNumber
    );
  }

  /**
   * @description Construct the ordered sequence of SpokePool flows between two blocks.
   * @param spokePoolClient SpokePoolClient instance for this chain.
   * @param fromBlock       Optional lower bound of the search range. Defaults to the SpokePool deployment block.
   * @param toBlock         Optional upper bound of the search range. Defaults to the latest queried block.
   * @return UBA flows in chronological ascending order.
   */
  public getFlows(chainId: number, tokenSymbol: string, fromBlock?: number, toBlock?: number): UbaFlow[] {
    return this.getModifiedFlows(chainId, tokenSymbol, fromBlock, toBlock).map(({ flow }) => flow);
  }

  /**
   * Construct the ordered sequence of SpokePool flows between two blocks. This function returns the flows with
   * additional fee data.
   * @param spokePoolClient SpokePoolClient instance for this chain.
   * @param fromBlock       Optional lower bound of the search range. Defaults to the SpokePool deployment block.
   * @param toBlock         Optional upper bound of the search range. Defaults to the latest queried block.
   * @returns The flows with closing balances for the given token on the given chainId between the given block numbers
   */
  public getModifiedFlows(
    chainId: number,
    tokenSymbol: string,
    fromBlock?: number,
    toBlock?: number
  ): ModifiedUBAFlow[] {
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    return relevantBundleStates
      .flatMap((bundleState) => bundleState.flows)
      .filter(
        ({ flow }) =>
          (fromBlock === undefined || flow.blockNumber >= fromBlock) &&
          (toBlock === undefined || flow.blockNumber <= toBlock)
      );
  }

  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number
   * @param tokenSymbol The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param balancingActionBlockNumber The block number to get the balancing fee for
   * @param chainId The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   */
  public computeBalancingFee(
    tokenSymbol: string,
    amount: BigNumber,
    balancingActionBlockNumber: number,
    chainId: number,
    feeType: UBAActionType
  ): BalancingFeeReturnType {
    // Opening balance for the balancing action blockNumber.
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);

    // If there are no bundle states for this token on this chain, then there is no fee.
    // This is a case where the token is newly supported and there are both no flows
    // yet and no root bundles that have been proposed.
    if (relevantBundleStates.length === 0) {
      return {
        balancingFee: ethers.constants.Zero,
        actionType: feeType,
      };
    }

    const specificBundleState = findLast(
      relevantBundleStates,
      (bundleState) => bundleState.openingBlockNumberForSpokeChain <= balancingActionBlockNumber
    );
    if (!specificBundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    }

    // If there are no flows in the bundle AFTER the balancingActionBlockNumber then its safer to throw an error
    // then risk returning an invalid Balancing fee because we're missing flows preceding the
    //  balancingActionBlockNumber.
    if (specificBundleState.closingBlockNumberForSpokeChain < balancingActionBlockNumber) {
      throw new Error("Bundle end block doesn't cover flow");
    }
    /** @TODO ADD TX INDEX COMPARISON */
    const flows = (specificBundleState?.flows ?? []).filter(
      (flow) => flow.flow.blockNumber <= balancingActionBlockNumber
    );
    const { runningBalance, incentiveBalance } = analog.calculateHistoricalRunningBalance(
      flows.map(({ flow }) => flow),
      specificBundleState.openingBalance,
      specificBundleState.openingIncentiveBalance,
      chainId,
      tokenSymbol,
      specificBundleState.config
    );
    const { balancingFee } = analog.feeCalculationFunctionsForUBA[feeType](
      amount,
      runningBalance,
      incentiveBalance,
      chainId,
      specificBundleState.config
    );
    return {
      balancingFee: balancingFee,
      actionType: feeType,
    };
  }

  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number for multiple refund chains
   * @param tokenSymbol The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param chainIds The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   * @note This function is used to compute the balancing fee for a given amount on multiple refund chains.
   */
  public computeBalancingFees(
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    chainIds: number[],
    feeType: UBAActionType
  ): BalancingFeeReturnType[] {
    return chainIds.map((chainId) =>
      this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, chainId, feeType)
    );
  }

  /**
   * Updates this UBAClient with a new state instance.
   * @param state The new state to include. If `state` is undefined/null, then it will be ignored
   * @returns void.
   */
  public async update(state?: UBAClientState): Promise<void> {
    if (state) {
      this.bundleStates = state;
    }
    this.isUpdated = true;
    return Promise.resolve();
  }
}
