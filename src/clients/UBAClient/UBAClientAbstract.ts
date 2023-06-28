import winston from "winston";
import { RefundRequestWithBlock, UbaFlow, UbaOutflow } from "../../interfaces";
import { BigNumber } from "ethers";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import { RelayerFeeDetails } from "../../relayFeeCalculator";
import { toBN } from "../../utils";
import {
  OpeningBalanceReturnType,
  RequestValidReturnType,
  BalancingFeeReturnType,
  SystemFeeResult,
  RelayerFeeResult,
  UBABundleState,
  UBAChainState,
} from "./UBAClientTypes";
import { UBAFeeSpokeCalculator } from "../../UBAFeeCalculator";

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * This class is not intended to be used directly, but rather extended by other classes that implement the abstract methods.
 */
export abstract class BaseUBAClient {
  /**
   * A mapping of Token Symbols to a mapping of ChainIds to a list of bundle states.
   * @note The bundle states are sorted in ascending order by block number.
   */
  private bundleStates: {
    [chainId: number]: UBAChainState;
  };

  protected constructor(
    protected readonly chainIdIndices: number[],
    protected readonly tokens: string[],
    protected readonly logger?: winston.Logger
  ) {
    this.bundleStates = {};
  }

  /**
   * Resolves the array of bundle states for a given token on a given chainId
   * @param chainId The chainId to get the bundle states for
   * @param tokenSymbol The token to get the bundle states for
   * @returns The array of bundle states for the given token on the given chainId if it exists, otherwise an empty array
   */
  protected retrieveBundleStates(chainId: number, tokenSymbol: string): UBABundleState[] {
    return this.bundleStates?.[chainId]?.bundles?.[tokenSymbol] ?? [];
  }

  /**
   * Retrieves the opening balance for a given token on a given chainId at a given block number
   * @param chainId The chainId to get the opening balance for
   * @param spokePoolToken The token to get the opening balance for
   * @param blockNumber The block number to get the opening balance for
   * @returns The opening balance for the given token on the given chainId at the given block number
   * @throws If the token cannot be found for the given chainId
   * @throws If the opening balance cannot be found for the given token on the given chainId at the given block number
   */
  public getOpeningBalance(
    chainId: number,
    tokenSymbol: string,
    blockNumber: number
  ): OpeningBalanceReturnType | undefined {
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    if (relevantBundleStates.length === 0) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    }
    const result = relevantBundleStates.find((bundleState) => bundleState.blockNumber <= blockNumber);
    return result
      ? {
          blockNumber: result.blockNumber,
          spokePoolBalance: result.openingBalance,
        }
      : undefined;
  }

  /**
   * @description Construct the ordered sequence of SpokePool flows between two blocks.
   * @note Assumptions:
   * @note Deposits, Fills and RefundRequests have been pre-verified by the SpokePool contract or SpokePoolClient, i.e.:
   * @note - Deposit events contain valid information.
   * @note - Fill events correspond to valid deposits.
   * @note - RefundRequest events correspond to valid fills.
   * @note In order to provide up-to-date prices, UBA functionality may want to follow close to "latest" and so may still
   * @note be exposed to finality risk. Additional verification that can only be performed within the UBA context:
   * @note - Only the first instance of a partial fill for a deposit is accepted. The total deposit amount is taken, and
   * @note   subsequent partial, complete or slow fills are disregarded.
   * @param spokePoolClient SpokePoolClient instance for this chain.
   * @param fromBlock       Optional lower bound of the search range. Defaults to the SpokePool deployment block.
   * @param toBlock         Optional upper bound of the search range. Defaults to the latest queried block.
   */
  public getFlows(chainId: number, tokenSymbol: string, fromBlock?: number, toBlock?: number): UbaFlow[] {
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    return relevantBundleStates
      .flatMap((bundleState) => bundleState.flows)
      .map((flow) => flow.flow)
      .filter(
        (flow) =>
          (fromBlock === undefined || flow.blockNumber >= fromBlock) &&
          (toBlock === undefined || flow.blockNumber <= toBlock)
      );
  }

  /**
   * @description Evaluate an RefundRequest object for validity.
   * @dev  Callers should evaluate 'valid' before 'reason' in the return object.
   * @dev  The following RefundRequest attributes are not evaluated for validity and should be checked separately:
   * @dev  - previousIdenticalRequests
   * @dev  - Age of blockNumber (i.e. according to SpokePool finality)
   * @param chainId       ChainId of SpokePool where refundRequest originated.
   * @param refundRequest RefundRequest object to be evaluated for validity.
   */
  public refundRequestIsValid(chainId: number, refundRequest: RefundRequestWithBlock): RequestValidReturnType {
    /** @TODO CREATE A LOOKUP */
    const result = this.getFlows(chainId, refundRequest.refundToken).some((flow) => {
      return (
        flow.logIndex == refundRequest.logIndex &&
        flow.blockNumber == refundRequest.blockNumber &&
        flow.transactionHash == refundRequest.transactionHash &&
        flow.transactionIndex == refundRequest.transactionIndex
      );
    });
    if(!result) {
      return {
        valid: false,
        reason: "RefundRequest is not a valid flow because it didn't appear in the list of validated flows.";
      }
    } else {
      return {
        valid: true
      }
    }
  }

  private async computeBalancingFeeInternal(
    tokenSymbol: string,
    amount: BigNumber,
    balancingActionBlockNumber: number,
    chainId: number,
    feeType: UBAActionType
  ): Promise<BalancingFeeReturnType> {
    // Opening balance for the balancing action blockNumber.
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    const specificBundleState = relevantBundleStates.findLast((bundleState) => bundleState.blockNumber <= balancingActionBlockNumber);
    if(!specificBundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    } 
    /** @TODO ADD TX INDEX COMPARISON */
    const flows = (specificBundleState?.flows ?? []).filter((flow) => flow.flow.blockNumber <= balancingActionBlockNumber).map(({flow}) => flow);
    const calculator = new UBAFeeSpokeCalculator(chainId, tokenSymbol, flows, balancingActionBlockNumber, specificBundleState.config.ubaConfig);
    const { balancingFee } =
      calculator[
        feeType === UBAActionType.Deposit ? "getDepositFee" : "getRefundFee"
      ](amount);
    return {
      balancingFee,
      actionType: feeType,
    };
  }

  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number
   * @param tokenSymbol The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param chainId The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   */
  public async computeBalancingFee(
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    balancingActionBlockNumber: number,
    chainId: number,
    feeType: UBAActionType
  ): Promise<BalancingFeeReturnType> {
    // Opening balance for the balancing action blockNumber.
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    const specificBundleState = relevantBundleStates.findLast((bundleState) => bundleState.blockNumber <= balancingActionBlockNumber);
    /** @TODO ADD TX INDEX COMPARISON */
    const flows = (specificBundleState?.flows ?? []).filter((flow) => flow.flow.blockNumber <= balancingActionBlockNumber);
    

    // // Verify that the spoke clients are instantiated.
    // await this.instantiateUBAFeeCalculator(chainId, tokenSymbol, hubPoolBlockNumber);
    // // Get the balancing fees.
    // const { balancingFee } =
    //   this.spokeUBAFeeCalculators[chainId][tokenSymbol][
    //     feeType === UBAActionType.Deposit ? "getDepositFee" : "getRefundFee"
    //   ](amount);
    return {
      balancingFee: toBN(0),
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
  ): Promise<BalancingFeeReturnType[]> {
    return Promise.all(
      chainIds.map((chainId) => this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, chainId, feeType))
    );
  }

  protected abstract computeLpFee(
    hubPoolTokenAddress: string,
    depositChainId: number,
    destinationChainId: number,
    amount: BigNumber
  ): Promise<BigNumber>;

  /**
   * Compute the entire system fee for a given amount. The system fee is the sum of the LP fee and the balancing fee.
   * @param depositChainId The chainId of the deposit
   * @param destinationChainId The chainId of the transaction
   * @param tokenSymbol The token to get the system fee for
   * @param hubPoolTokenAddress The token address of the token on the hub pool chain
   * @param amount The amount to get the system fee for
   * @param hubPoolBlockNumber The block number to get the system fee for
   * @returns The system fee for the given token on the given chainId at the given block number
   */
  public async computeSystemFee(
    depositChainId: number,
    destinationChainId: number,
    tokenSymbol: string,
    hubPoolTokenAddress: string,
    amount: BigNumber,
    hubPoolBlockNumber: number
  ): Promise<SystemFeeResult> {
    const [lpFee, { balancingFee: depositBalancingFee }] = await Promise.all([
      this.computeLpFee(hubPoolTokenAddress, depositChainId, destinationChainId, amount),
      this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, depositChainId, UBAActionType.Deposit),
    ]);
    return { lpFee, depositBalancingFee, systemFee: lpFee.add(depositBalancingFee) };
  }

  /**
   * Compute the entire relayer fee for a given amount. The relayer fee is the sum of the gas fee, the capital fee.
   * @param tokenSymbol The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param depositChainId The chainId of the deposit
   * @param refundChainId The chainId of the refund
   * @param tokenPrice The price of the token
   * @returns The relayer fee for the given token on the given chainId at the given block number
   */
  protected abstract computeRelayerFees(
    tokenSymbol: string,
    amount: BigNumber,
    depositChainId: number,
    refundChainId: number,
    tokenPrice?: number
  ): Promise<RelayerFeeDetails>;

  /**
   * Compute the entire Relayer fee in the context of the UBA system for a given amount. The relayer fee is the sum of the gas fee, the capital fee, and the balancing fee.
   * @param depositChain The chainId of the deposit
   * @param refundChain The chainId of the refund
   * @param tokenSymbol The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns The relayer fee for the given token on the given chainId at the given block number
   */
  public async getRelayerFee(
    depositChain: number,
    refundChain: number,
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<RelayerFeeResult> {
    const [relayerFeeDetails, { balancingFee }] = await Promise.all([
      this.computeRelayerFees(tokenSymbol, amount, depositChain, refundChain, tokenPrice),
      this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, refundChain, UBAActionType.Refund),
    ]);
    return {
      relayerGasFee: toBN(relayerFeeDetails.gasFeeTotal),
      relayerCapitalFee: toBN(relayerFeeDetails.capitalFeeTotal),
      relayerBalancingFee: balancingFee,
      relayerFee: balancingFee.add(relayerFeeDetails.relayFeeTotal),
      amountTooLow: relayerFeeDetails.isAmountTooLow,
    };
  }

  /**
   * Compute the entire UBA fee in the context of the UBA system for a given amount. The UBA fee is comprised of 7 return variables.
   * @param depositChain The chainId of the deposit
   * @param refundChain The chainId of the refund
   * @param tokenSymbol The token to get the relayer fee for
   * @param hubPoolTokenAddress The token address of the token on the hub pool chain
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns The UBA fee for the given token on the given chainId at the given block number
   */
  public async getUBAFee(
    depositChain: number,
    refundChain: number,
    tokenSymbol: string,
    hubPoolTokenAddress: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<RelayerFeeResult & SystemFeeResult> {
    const [relayerFee, systemFee] = await Promise.all([
      this.getRelayerFee(depositChain, refundChain, tokenSymbol, amount, hubPoolBlockNumber, tokenPrice),
      this.computeSystemFee(depositChain, refundChain, tokenSymbol, hubPoolTokenAddress, amount, hubPoolBlockNumber),
    ]);
    return {
      ...relayerFee,
      ...systemFee,
    };
  }

  /**
   * Compute the entire UBA fee in the context of the UBA system for a given amount. The UBA fee is comprised of 7 return variables. This function is used to compute the UBA fee for a given amount on multiple refund chains.
   * The function returns a record of the UBA fee for each refund chain that is not too low.
   * @param depositChain The chainId of the deposit
   * @param refundChainCandidates The chainIds of the refund candidates
   * @param tokenSymbol The token to get the relayer fee for
   * @param hubPoolTokenAddress The token address of the token on the hub pool chain
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns A record of the UBA fee for each refund chain that is not too low
   */
  public async getUBAFeeFromCandidates(
    depositChain: number,
    refundChainCandidates: number[],
    tokenSymbol: string,
    hubPoolTokenAddress: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<Record<number, RelayerFeeResult & SystemFeeResult>> {
    const transformation = await Promise.all(
      refundChainCandidates.map(async (refundChain) => {
        return [
          refundChain,
          await this.getUBAFee(
            depositChain,
            refundChain,
            tokenSymbol,
            hubPoolTokenAddress,
            amount,
            hubPoolBlockNumber,
            tokenPrice
          ),
        ] as [number, RelayerFeeResult & SystemFeeResult];
      })
    );
    return Object.fromEntries(transformation.filter(([, result]) => !result.amountTooLow));
  }
}
