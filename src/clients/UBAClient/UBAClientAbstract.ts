import winston from "winston";
import { RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { BigNumber } from "ethers";
import { UBAFeeSpokeCalculator } from "../../UBAFeeCalculator";
import { RelayerFeeDetails } from "../../relayFeeCalculator";
import { toBN } from "../../utils";

export type RequestValidReturnType = { valid: false; reason: string } | { valid: true };
export type OpeningBalanceReturnType = { blockNumber: number; spokePoolBalance: BigNumber };
export type BalancingFeeReturnType = { depositBalancingFee: BigNumber; refundBalancingFee: BigNumber };
export type SystemFeeResult = { lpFee: BigNumber; depositBalancingFee: BigNumber; systemFee: BigNumber };
export type RelayerFeeResult = {
  relayerGasFee: BigNumber;
  relayerCapitalFee: BigNumber;
  relayerBalancingFee: BigNumber;
  relayerFee: BigNumber;
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
  public abstract refundRequestIsValid(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _chainId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _refundRequest: RefundRequestWithBlock
  ): RequestValidReturnType;

  protected abstract instantiateUBAFeeCalculator(chainId: number, token: string, fromBlock: number): Promise<void>;

  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number
   * @param spokePoolToken The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param depositChainId The chainId of the deposit
   * @param refundChainId The chainId of the refund
   * @returns The balancing fee for the given token on the given chainId at the given block number
   */
  protected async computeBalancingFee(
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    depositChainId: number,
    refundChainId: number
  ): Promise<BalancingFeeReturnType> {
    // Verify that the spoke clients are instantiated.
    await Promise.all([
      this.instantiateUBAFeeCalculator(depositChainId, spokePoolToken, hubPoolBlockNumber),
      this.instantiateUBAFeeCalculator(refundChainId, spokePoolToken, hubPoolBlockNumber),
    ]);
    // Get the balancing fees.
    const [{ balancingFee: depositBalancingFee }, { balancingFee: refundBalancingFee }] = await Promise.all([
      this.spokeUBAFeeCalculators[depositChainId][spokePoolToken].getDepositFee(amount),
      this.spokeUBAFeeCalculators[refundChainId][spokePoolToken].getRefundFee(amount),
    ]);
    return {
      depositBalancingFee,
      refundBalancingFee,
    };
  }

  protected abstract computeRealizedLpFee(
    l1TokenAddress: string,
    depositChainId: number,
    refundChainId: number,
    amount: BigNumber
  ): Promise<BigNumber>;

  /**
   * Compute the entire system fee for a given amount. The system fee is the sum of the LP fee and the balancing fee.
   * @param depositChain The chainId of the deposit
   * @param refundChain The chainId of the refund
   * @param spokePoolToken The token to get the system fee for
   * @param amount The amount to get the system fee for
   * @param hubPoolBlockNumber The block number to get the system fee for
   * @returns The system fee for the given token on the given chainId at the given block number
   */
  public async computeSystemFee(
    depositChain: number,
    refundChain: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number
  ): Promise<SystemFeeResult> {
    const [lpFee, { depositBalancingFee: depositBalancingFee }] = await Promise.all([
      this.computeRealizedLpFee(spokePoolToken, depositChain, refundChain, amount),
      this.computeBalancingFee(spokePoolToken, amount, hubPoolBlockNumber, depositChain, refundChain),
    ]);
    return { lpFee, depositBalancingFee, systemFee: lpFee.add(depositBalancingFee) };
  }

  /**
   * Compute the relayer fees for a given amount.
   */
  protected abstract computeRelayerFees(
    l1TokenAddress: string,
    amount: BigNumber,
    depositChainId: number,
    refundChainId: number,
    tokenPrice?: number
  ): Promise<RelayerFeeDetails>;

  public async getRelayerFee(
    depositChain: number,
    refundChain: number,
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    tokenPrice?: number
  ): Promise<RelayerFeeResult> {
    const [relayerFeeDetails, { refundBalancingFee: balancingFee }] = await Promise.all([
      this.computeRelayerFees(spokePoolToken, amount, depositChain, refundChain, tokenPrice),
      this.computeBalancingFee(spokePoolToken, amount, hubPoolBlockNumber, depositChain, refundChain),
    ]);
    return {
      relayerGasFee: toBN(relayerFeeDetails.gasFeeTotal),
      relayerCapitalFee: toBN(relayerFeeDetails.capitalFeeTotal),
      relayerBalancingFee: balancingFee,
      relayerFee: balancingFee.add(relayerFeeDetails.relayFeeTotal),
    };
  }

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
}
