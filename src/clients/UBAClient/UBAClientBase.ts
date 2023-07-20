import winston from "winston";
import { UbaFlow } from "../../interfaces";
import { UBABundleState, UBAClientState, ModifiedUBAFlow } from "./UBAClientTypes";
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
   * @param tokens A list of all tokens that the UBA functionality should be implemented for
   * @param maxBundleStates The maximum number of bundle states to keep in memory
   * @param hubChainId The chainId of the hub chain
   * @param logger An optional logger to use for logging
   */
  constructor(
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
