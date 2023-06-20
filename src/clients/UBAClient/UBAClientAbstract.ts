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
   * @param spokePoolToken The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param chainId The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   */
  public async computeBalancingFee(
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    chainId: number,
    feeType: UBAActionType
  ): Promise<BalancingFeeReturnType> {
    // Verify that the spoke clients are instantiated.
    await this.instantiateUBAFeeCalculator(chainId, spokePoolToken, hubPoolBlockNumber);
    // Get the balancing fees.
    const { balancingFee } =
      this.spokeUBAFeeCalculators[chainId][spokePoolToken][
        feeType === UBAActionType.Deposit ? "getDepositFee" : "getRefundFee"
      ](amount);
    return {
      balancingFee,
      actionType: feeType,
    };
  }

  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number for multiple refund chains
   * @param spokePoolToken The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param chainIds The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   * @note This function is used to compute the balancing fee for a given amount on multiple refund chains.
   */
  public computeBalancingFees(
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    chainIds: number[],
    feeType: UBAActionType
  ): Promise<BalancingFeeReturnType[]> {
    return Promise.all(
      chainIds.map((chainId) => this.computeBalancingFee(spokePoolToken, amount, hubPoolBlockNumber, chainId, feeType))
    );
  }

  protected abstract computeLpFee(
    hubPoolTokenAddress: string,
    depositChainId: number,
    refundChainId: number,
    amount: BigNumber
  ): Promise<BigNumber>;

  /**
   * Compute the entire system fee for a given amount. The system fee is the sum of the LP fee and the balancing fee.
   * @param depositChainId The chainId of the deposit
   * @param destinationChainId The chainId of the transaction
   * @param spokePoolToken The token to get the system fee for
   * @param amount The amount to get the system fee for
   * @param hubPoolBlockNumber The block number to get the system fee for
   * @returns The system fee for the given token on the given chainId at the given block number
   */
  public async computeSystemFee(
    depositChainId: number,
    destinationChainId: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number
  ): Promise<SystemFeeResult> {
    const [lpFee, { balancingFee: depositBalancingFee }] = await Promise.all([
      this.computeLpFee(spokePoolToken, depositChainId, destinationChainId, amount),
      this.computeBalancingFee(spokePoolToken, amount, hubPoolBlockNumber, depositChainId, UBAActionType.Deposit),
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
   * @param spokePoolToken The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns The relayer fee for the given token on the given chainId at the given block number
   */
  public async getRelayerFee(
    depositChain: number,
    refundChain: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<RelayerFeeResult> {
    const [relayerFeeDetails, { balancingFee }] = await Promise.all([
      this.computeRelayerFees(spokePoolToken, amount, depositChain, refundChain, tokenPrice),
      this.computeBalancingFee(spokePoolToken, amount, hubPoolBlockNumber, refundChain, UBAActionType.Refund),
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
   * @param spokePoolToken The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns The UBA fee for the given token on the given chainId at the given block number
   */
  public async getUBAFee(
    depositChain: number,
    refundChain: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<RelayerFeeResult & SystemFeeResult> {
    const [relayerFee, systemFee] = await Promise.all([
      this.getRelayerFee(depositChain, refundChain, spokePoolToken, amount, hubPoolBlockNumber, tokenPrice),
      this.computeSystemFee(depositChain, refundChain, spokePoolToken, amount, hubPoolBlockNumber),
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
   * @param spokePoolToken The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param tokenPrice The price of the token
   * @returns A record of the UBA fee for each refund chain that is not too low
   */
  public async getUBAFeeFromCandidates(
    depositChain: number,
    refundChainCandidates: number[],
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<Record<number, RelayerFeeResult & SystemFeeResult>> {
    const transformation = await Promise.all(
      refundChainCandidates.map(async (refundChain) => {
        return [
          refundChain,
          await this.getUBAFee(depositChain, refundChain, spokePoolToken, amount, hubPoolBlockNumber, tokenPrice),
        ] as [number, RelayerFeeResult & SystemFeeResult];
      })
    );
    return Object.fromEntries(transformation.filter(([, result]) => !result.amountTooLow));
  }
}
