import { BigNumber } from "ethers";
import { UBAFeeResult, UBAFlowRange } from "../interfaces";
import UBAConfig from "./UBAFeeConfig";
import { getDepositBalancingFee, getRefundBalancingFee } from "./UBAFeeUtility";
import { toBN } from "../utils";
import { Logger } from "winston";
import { UBAFeeSpokeStore } from "./UBAFeeSpokeStore";

// This file holds the UBA Fee Calculator class. The goal of this class is to keep track
// of the running balance of a given spoke pool by fetching the most recent confirmed bundle
// and computing the inflows and outflows to find the running balance.
// The class can use this running balance to calculate the fee for a given action (request or refund)

/**
 * @file UBAFeeCalculator.ts
 * @description UBA Fee Calculator
 * @author Across Bots Team
 */
export default class UBAFeeCalculator {
  constructor(
    private readonly config: UBAConfig,
    private readonly logger: Logger,
    protected readonly originSpoke: UBAFeeSpokeStore,
    protected readonly refundSpoke: UBAFeeSpokeStore
  ) {
    this.logger.debug("UBA Fee Calculator initialized");
  }

  /**
   * @description Get the recent request flow
   * @param action The action to get the fee for
   * @returns The relevant fee
   */
  public async getUBAFee(amount: BigNumber, flowRange?: UBAFlowRange): Promise<UBAFeeResult> {
    // Get the origin and refund chain ids
    const originChain = this.originSpoke.chainId;
    const refundChain = this.refundSpoke.chainId;

    const refundRunningBalance = this.refundSpoke.calculateHistoricalRunningBalance(
      flowRange?.startIndex,
      flowRange?.endIndex
    );
    const originRunningBalance = this.originSpoke.calculateHistoricalRunningBalance(
      flowRange?.startIndex,
      flowRange?.endIndex
    );

    let depositorFee = toBN(0);
    let refundFee = toBN(0);

    // Resolve the alpha fee of this action
    const alphaFee = this.config.getBaselineFee(originChain, refundChain);

    // Contribute the alpha fee to the LP fee
    depositorFee = depositorFee.add(alphaFee);

    // Resolve the utilization fee
    const utilizationFee = this.config.getUtilizationFee();

    // Contribute the utilization fee to the Relayer fee
    refundFee = refundFee.add(utilizationFee);

    // Resolve the balancing fee tuples that are relevant to this operation
    const originBalancingFeeTuples = this.config.getBalancingFeeTuples(originChain);
    const refundBalancingFeeTuples = this.config.getBalancingFeeTuples(refundChain);

    refundFee = refundFee.add(getRefundBalancingFee(refundBalancingFeeTuples, refundRunningBalance, amount));
    depositorFee = depositorFee.add(getDepositBalancingFee(originBalancingFeeTuples, originRunningBalance, amount));

    // Find the gas fee of this action in the refund chain
    // TODO: This value below is related to the gas fee

    return {
      depositorFee,
      refundFee,
      totalUBAFee: depositorFee.add(refundFee),
    };
  }

  public getHistoricalUBAFees(type: "refund" | "origin"): Promise<UBAFeeResult[]> {
    const spoke = type === "refund" ? this.refundSpoke : this.originSpoke;
    return Promise.all(
      spoke.recentRequestFlow.map((flow, idx) => this.getUBAFee(flow.amount, { startIndex: 0, endIndex: idx }))
    );
  }
}
