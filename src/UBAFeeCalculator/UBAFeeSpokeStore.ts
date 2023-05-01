import { BigNumber } from "ethers";
import { UbaFlow, isUbaInflow, isUbaOutflow } from "../interfaces";
import { toBN } from "../utils";

/**
 * @file UBAFeeSpokeStore.ts
 * @description UBA Fee Spoke Store - meant to memoize the running balance of a spoke so that we don't have to recompute it N^2 times in the UBA Fee Calculator
 */
export class UBAFeeSpokeStore {
  /**
   * @description The last validated running balance of the spoke
   */
  protected lastValidatedRunningBalance?: BigNumber;

  /**
   * @description The cached running balance of the spoke at each step in the recent request flow
   */
  private cachedRunningBalance: Record<string, BigNumber>;

  /**
   * Instantiates a new UBA Fee Spoke Store
   * @param chainId The chain id of the spoke
   * @param recentRequestFlow The recent request flow of the spoke
   * @param blockNumber The most recent block number
   */
  constructor(
    public readonly chainId: number,
    public readonly recentRequestFlow: UbaFlow[],
    public blockNumber: number
  ) {
    this.lastValidatedRunningBalance = undefined;
    this.cachedRunningBalance = {};
  }

  /**
   * Calculates the historical running balance of the spoke from the last validated running balance
   * by aggregating the inflows and outflows of the spoke from the given starting step and extending
   * the aggregation for the given length.
   * @param startingStepFromLastValidatedBalance The starting step from the last validated balance. Defaults to 0.
   * @param lengthOfRunningBalance The length of the running balance. Defaults to the length of the recent request flow.
   * @returns The historical running balance
   */
  public calculateHistoricalRunningBalance(
    startingStepFromLastValidatedBalance?: number,
    lengthOfRunningBalance?: number
  ): BigNumber {
    const startIdx = startingStepFromLastValidatedBalance ?? 0;
    const length = lengthOfRunningBalance ?? this.recentRequestFlow.length + 1;
    const endIdx = startIdx + length;
    const key = `${startIdx}-${endIdx}`;

    // If the key is in the cache, return the cached value
    // We don't need to compute the running balance again
    if (key in this.cachedRunningBalance) {
      return this.cachedRunningBalance[key];
    }

    // If the last validated running balance is undefined, we need to compute the running balance from scratch
    // This is the case when the UBA Fee Calculator is first initialized or run on a range
    // that we haven't computed the running balance for yet
    const historicalResult = this.recentRequestFlow.slice(startIdx, endIdx).reduce((acc, flow) => {
      if (isUbaInflow(flow)) {
        return acc.add(toBN(flow.amount));
      } else if (isUbaOutflow(flow)) {
        return acc.sub(toBN(flow.amount));
      } else {
        return acc;
      }
    }, this.lastValidatedRunningBalance ?? toBN(0));

    // Cache the result
    this.cachedRunningBalance[key] = historicalResult;

    // Return the result
    return historicalResult;
  }

  /**
   * Calculates the recent running balance of the spoke by aggregating the inflows and outflows of the spoke
   * from the most recent block number to the most recent block number + 1. This is a convenience method for
   * calculateHistoricalRunningBalance with the default parameters of 0 and the length of the recent request flow.
   * @returns The recent running balance
   */
  public calculateRecentRunningBalance(): BigNumber {
    return this.calculateHistoricalRunningBalance(0, this.recentRequestFlow.length + 1);
  }

  /**
   * Clears the cached running balance of the spoke
   */
  public clearCachedRunningBalance(): void {
    this.cachedRunningBalance = {};
  }
}
