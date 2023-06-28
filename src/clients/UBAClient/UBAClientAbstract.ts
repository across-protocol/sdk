import winston from "winston";
import { RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { BigNumber } from "ethers";
import { UBAFeeSpokeCalculator } from "../../UBAFeeCalculator";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import { RelayerFeeDetails } from "../../relayFeeCalculator";
import { toBN } from "../../utils";

export type RequestValidReturnType = { valid: false; reason: string } | { valid: true };
export type OpeningBalanceReturnType = { blockNumber: number; spokePoolBalance: BigNumber };
export type BalancingFeeReturnType = { balancingFee: BigNumber; actionType: UBAActionType };
export type SystemFeeResult = { lpFee: BigNumber; depositBalancingFee: BigNumber; systemFee: BigNumber };
export type RelayerFeeResult = {
  relayerGasFee: BigNumber;
  relayerCapitalFee: BigNumber;
  relayerBalancingFee: BigNumber;
  relayerFee: BigNumber;
  amountTooLow: boolean;
};

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * This class is not intended to be used directly, but rather extended by other classes that implement the abstract methods.
 */
export abstract class BaseUBAClient {
  protected spokeUBAFeeCalculators: { [chainId: number]: { [token: string]: UBAFeeSpokeCalculator } };

  protected constructor(protected readonly chainIdIndices: number[], protected readonly logger?: winston.Logger) {
    this.spokeUBAFeeCalculators = {};
  }

  // public async getFlowsForChain(events: Event[]) {
  //   // Given an input of deposit, fill, refundRequest events for a chain,
  //   // give me the deterministic time series of VALID flows.
  //   // Per enabled chain, per supported token:
  //   // - Going through flows in order, compute balancing fee for that flow and assign the latest running balance
  //   // and balancing fee to that flow.
  //   // - Clients can now instantly get the balancing fees for each flow
  //   // - Ideally, cache each resultant flow.
  // }

  /**
   * Retrieves the opening balance for a given token on a given chainId at a given block number
   * @param chainId The chainId to get the opening balance for
   * @param spokePoolToken The token to get the opening balance for
   * @param hubPoolBlockNumber The block number to get the opening balance for
   * @returns The opening balance for the given token on the given chainId at the given block number
   * @throws If the token cannot be found for the given chainId
   * @throws If the opening balance cannot be found for the given token on the given chainId at the given block number
   */
  public abstract getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): OpeningBalanceReturnType;

  /**
   * Gets the latest block number for a given chainId in the state of the lastest closing block
   * @param chainId The chainId to get the latest block number for
   * @returns The latest block number for the given chainId
   * @note Assumes that the `spoke[...].bundleEndBlocks` are sorted in ascending order
   */
  protected abstract resolveClosingBlockNumber(chainId: number, blockNumber: number): number;

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
  public abstract getFlows(chainId: number, fromBlock?: number, toBlock?: number): UbaFlow[];

  /**
   * @description Evaluate an RefundRequest object for validity.
   * @dev  Callers should evaluate 'valid' before 'reason' in the return object.
   * @dev  The following RefundRequest attributes are not evaluated for validity and should be checked separately:
   * @dev  - previousIdenticalRequests
   * @dev  - Age of blockNumber (i.e. according to SpokePool finality)
   * @param chainId       ChainId of SpokePool where refundRequest originated.
   * @param refundRequest RefundRequest object to be evaluated for validity.
   */
  public abstract refundRequestIsValid(chainId: number, refundRequest: RefundRequestWithBlock): RequestValidReturnType;

  protected abstract instantiateUBAFeeCalculator(chainId: number, token: string, fromBlock: number): Promise<void>;

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
    hubPoolBlockNumber: number, // block corresponding to quote timestamp of deposit or refund
    // balancingActionBlockNumber: number,
    chainId: number, // same chain as balancingAction
    feeType: UBAActionType
  ): Promise<BalancingFeeReturnType> {
    // Idea: Maybe move the following algorithm to the update() method in the UBAClient
    // 1. Get latest running balance before balancingActionBlockNumber for `chainId`: openingRunningBalance.
    // hubPoolClient.getRunningBalanceBeforeBlockForChain(
    //   balancingActionBlockNumber,
    //   chainId,
    //   l1Token
    // )
    // 2. Get all *valid flows between bundle end block in last snapshotted bundle and balancingActionBlockNumber.
    // 3. Use the above to pass into getDepositFee(latestRunningBalance, amount).

    // * To get all valid flows, go through them one by one and validate their balancing fees by recursively calling
    // back into this function computeBalancingFee(). This should be possible if you go through the flows in order.

    // For example:
    // - `chainId` = 10, Optimism
    // - runningBalance snapshotted at block 1 on Ethereum for the `chainId` where the bundle end block was 7 = 100
    // - we want to get the balancing fee for a deposit amount = +10 (+ for deposit, - for refund),
    //   Ethereum block = 5, Optimism block = 10
    // - The following events have happened on the deposit origin `chainId`, Optimism:
    // - [block, amount]: [1, +25], [2, -10], [6, +85], [8, +50], [9, -10], [9, +500], [10, -99]
    // - Now let's follow the above algorithm:
    // - 1) Get latest running balance before balancingActionBlockNumber for Optimism: balancingActionBlockNumber = 10,
    //      and latest running balance for `chainId` was 100 at bundle end block 7. 7 < 10, so openingRunningBalance = 100.
    // - 2) Get all *valid flows between 7 and balancingActionBlockNumber = 10: We need to go through the
    //      flows in order. First flow is occurred at block 8 on `chainId` and deposited 50. Call `getDepositFee(100, +50)`
    //      let's say that it returns 3%. So, validate that the flow [8, +50] used the correct fee. Next, validate the
    //      flow that occurred at block 9 and refunded 10. Call `getDepositFee(150, -10)` where we pass in 150 as the
    //      "latest" running balance because we validated that the flow [8, +50] was valid. Let's say that it returns 2%.
    //      Let's then imagine that the refund for 10 tokens incorrectly set the balancing fee (i.e. it should have been 2%).
    //      That means that we need to ignore that -10 value. So the next flow to validate is [9, +500]. Call
    //      getDepositFee(150, +500) and let's say that it returns 4%. We will pretend this flow used the correct fee.
    //      The final flow to validate is [10, -99]. Call getDepositFee(650, -99) and let's say that it returns 3.5%
    //      and the event was valid.
    // - 3) Now we know the latest running balance before the balancingActionBlockNumber was 650 - 99 = 551.
    //      To get the balancing fee, we call getDepositFee(551, +10).

    // Optimizations:
    // 1) Deposits are always valid, you can't forget a deposit so it will always contribute to a flow
    // 2) Refunds are not always valid so you need to validate that the fill/refund used the correct system fee.

    // Verify that the spoke clients are instantiated.
    await this.instantiateUBAFeeCalculator(chainId, tokenSymbol, hubPoolBlockNumber);
    // Get the balancing fees.
    const { balancingFee } =
      this.spokeUBAFeeCalculators[chainId][tokenSymbol][
        feeType === UBAActionType.Deposit ? "getDepositFee" : "getRefundFee"
      ](amount);
    return {
      balancingFee,
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
