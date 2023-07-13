import { BigNumber } from "ethers";
import { TokenRunningBalance, UbaFlow } from "../interfaces";
import UBAConfig from "./UBAFeeConfig";
import { TokenRunningBalanceWithNetSend, UBAFlowFee, ThresholdBoundType } from "./UBAFeeTypes";
import { calculateHistoricalRunningBalance, getEventFee } from "./UBAFeeSpokeCalculatorAnalog";

/**
 * This file contains the implementation of the UBA Fee Spoke Calculator class. This class is
 * responsible for calculating the Universal Bridge Adapter fees for a given spoke. This class
 * contains a caching mechanism to avoid recomputing the running balance of the spoke for each
 * fee calculation.
 */
export default class UBAFeeSpokeCalculator {
  /**
   * Instantiates a new UBA Fee Spoke Store
   * @param chainId The chain id of the spoke
   * @param symbol The symbol of the token on the spoke
   * @param recentRequestFlow The recent request flow of the spoke
   * @param lastValidatedRunningBalance The last validated running balance of the spoke
   * @param lastValidatedIncentiveRunningBalance The last validated incentive running balance of the spoke
   * @param config The UBA Fee Config
   */
  constructor(
    public readonly chainId: number,
    public readonly symbol: string,
    public readonly recentRequestFlow: UbaFlow[],
    public readonly lastValidatedRunningBalance: BigNumber,
    public readonly lastValidatedIncentiveRunningBalance: BigNumber,
    public readonly config: UBAConfig
  ) {}

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
  ): TokenRunningBalanceWithNetSend {
    const startIdx = startingStepFromLastValidatedBalance ?? 0;
    const length = lengthOfRunningBalance ?? this.recentRequestFlow.length + 1;
    const endIdx = startIdx + length;

    // We'll need to now compute the concept of the running balance of the spoke
    return calculateHistoricalRunningBalance(
      this.recentRequestFlow.filter((_, idx) => idx >= startIdx && idx <= endIdx),
      this.lastValidatedRunningBalance,
      this.lastValidatedIncentiveRunningBalance,
      this.chainId,
      this.symbol,
      this.config
    );
  }

  /**
   * Calculates the recent running balance of the spoke by aggregating the inflows and outflows of the spoke
   * from the most recent block number to the most recent block number + 1. This is a convenience method for
   * calculateHistoricalRunningBalance with the default parameters of 0 and the length of the recent request flow.
   * @returns The recent running balance
   */
  public calculateRecentRunningBalance(): TokenRunningBalance {
    return this.calculateHistoricalRunningBalance(0, this.recentRequestFlow.length + 1);
  }

  /**
   * A convenience method for resolving the balance trigger threshold for the spoke
   * and the given symbol
   * @returns The balance trigger threshold for the spoke and the given symbol
   * @see UBAConfig.getBalanceTriggerThreshold
   */
  public getBalanceTriggerThreshold(): ThresholdBoundType {
    return this.config.getBalanceTriggerThreshold(this.chainId, this.symbol);
  }

  /**
   * A convenience method for resolving the event fee for the spoke and the given symbol and a given flow type
   * @param amount The amount of tokens to simulate
   * @param flowType The flow type to simulate
   * @returns The event fee for the spoke and the given symbol and a given flow type
   */
  protected getEventFee(amount: BigNumber, flowType: "inflow" | "outflow"): UBAFlowFee {
    return getEventFee(
      amount,
      flowType,
      this.lastValidatedRunningBalance,
      this.lastValidatedIncentiveRunningBalance,
      this.chainId,
      this.config
    );
  }

  /**
   * Calculates the fee for a simulated deposit operation
   * @param amount The amount of tokens to deposit
   * @returns The fee for the simulated deposit operation
   */
  public getDepositFee(amount: BigNumber): UBAFlowFee {
    return this.getEventFee(amount, "inflow");
  }

  /**
   * Calculates the fee for a simulated refund operation
   * @param amount The amount of tokens to refund
   * @param flowRange The range of the flow to simulate the refund for. Defaults to undefined to simulate the refund for the entire flow.
   * @returns The fee for the simulated refund operation
   */
  public getRefundFee(amount: BigNumber): UBAFlowFee {
    return this.getEventFee(amount, "outflow");
  }
}
