import winston from "winston";
import { UbaFlow } from "../../interfaces";
import { BigNumber } from "ethers";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import {
  OpeningBalanceReturnType,
  BalancingFeeReturnType,
  SystemFeeResult,
  RelayerFeeResult,
  UBABundleState,
  UBAChainState,
  UBALPFeeOverride,
  UBAClientState,
  ClosingBalanceReturnType,
  ModifiedUBAFlow,
} from "./UBAClientTypes";
import { computeLpFeeStateful } from "./UBAClientUtilities";
import { findLast } from "../../utils/ArrayUtils";
import { analog } from "../../UBAFeeCalculator";
import { BaseAbstractClient } from "../BaseAbstractClient";

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * This class is not intended to be used directly, but rather extended by other classes that implement the abstract methods.
 */
export abstract class BaseUBAClient extends BaseAbstractClient {
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
   * @param logger An optional logger to use for logging
   */
  constructor(
    protected readonly chainIdIndices: number[],
    protected readonly tokens: string[],
    protected readonly maxBundleStates: number,
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
  protected retrieveBundleStates(chainId: number, tokenSymbol: string): UBABundleState[] {
    return this.bundleStates?.[chainId]?.bundles?.[tokenSymbol] ?? [];
  }

  /**
   * Resolves the last bundle state for a given token on a given chainId
   * @param chainId The chainId to get the last bundle state for
   * @param tokenSymbol The token to get the last bundle state for
   * @returns The last bundle state for the given token on the given chainId if it exists, otherwise undefined
   */
  protected retrieveLastBundleState(chainId: number, tokenSymbol: string): UBABundleState | undefined {
    return this.retrieveBundleStates(chainId, tokenSymbol).at(-1);
  }

  /**
   * Retrieves the bundle state for a given token on a given chainId preceding a given block number
   * @param chainId The chainId to get the opening balance for
   * @param spokePoolToken The token to get the opening balance for
   * @param blockNumber The block number to get the opening balance for
   * @returns The opening balance for the given token on the given chainId at the given block number
   * @throws If the token cannot be found for the given chainId
   * @throws If the opening balance cannot be found for the given token on the given chainId at the given block number
   */
  public getPrecedingBundleState(
    chainId: number,
    tokenSymbol: string,
    blockNumber: number
  ): OpeningBalanceReturnType | undefined {
    const relevantBundleStates = this.retrieveBundleStates(chainId, tokenSymbol);
    if (relevantBundleStates.length === 0) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    }
    return findLast(relevantBundleStates, (bundleState) => bundleState.openingBlockNumberForSpokeChain <= blockNumber);
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
    return this.getModifiedFlows(chainId, tokenSymbol, fromBlock, toBlock).map(({ flow }) => flow);
  }

  /**
   * Construct the ordered sequence of SpokePool flows between two blocks. This function returns the flows with closing balances.
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
    const specificBundleState = findLast(
      relevantBundleStates,
      (bundleState) => bundleState.openingBlockNumberForSpokeChain <= balancingActionBlockNumber
    );
    if (!specificBundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${chainId}`);
    }
    /** @TODO ADD TX INDEX COMPARISON */
    const flows = (specificBundleState?.flows ?? []).filter(
      (flow) => flow.flow.blockNumber <= balancingActionBlockNumber
    );
    const { balancingFee } = analog.feeCalculationFunctionsForUBA[feeType](
      amount,
      flows.map(({ flow }) => flow),
      specificBundleState.openingBalance,
      specificBundleState.openingIncentiveBalance,
      chainId,
      tokenSymbol,
      specificBundleState.config.ubaConfig
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
  ): Promise<BalancingFeeReturnType[]> {
    return Promise.all(
      chainIds.map((chainId) => this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, chainId, feeType))
    );
  }

  /**
   * Compute the LP fee for a given amount. The LP fee is the fee paid to the LP for providing liquidity.
   * @param amount The amount to get the LP fee for
   * @param depositChainId The chainId of the deposit
   * @param hubPoolChainId The chainId of the hub pool
   * @param tokenSymbol The token to get the LP fee for
   * @param refundChainId The chainId of the refund
   * @param overrides The overrides to use for the LP fee calculation
   * @returns The LP fee for the given token on the given chainId at the given block number
   */
  protected computeLpFee(
    amount: BigNumber,
    depositChainId: number,
    hubPoolChainId: number,
    tokenSymbol: string,
    refundChainId?: number,
    overrides?: UBALPFeeOverride
  ): BigNumber {
    if (!overrides) {
      const recentBundleState = this.retrieveLastBundleState(hubPoolChainId, tokenSymbol);
      if (!recentBundleState) {
        throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${hubPoolChainId}`);
      }
      overrides = {
        decimals: recentBundleState.config.tokenDecimals,
        hubBalance: recentBundleState.config.hubBalance,
        hubEquity: recentBundleState.config.hubEquity,
        ethSpokeBalance: recentBundleState.config.hubPoolSpokeBalance,
        spokeTargets: recentBundleState.config.spokeTargets,
        baselineFee: recentBundleState.config.ubaConfig.getBaselineFee(refundChainId ?? depositChainId, depositChainId),
        gammaCutoff: recentBundleState.config.ubaConfig.getLpGammaFunctionTuples(depositChainId),
      };
    }
    const { decimals, hubBalance, hubEquity, ethSpokeBalance, spokeTargets, baselineFee, gammaCutoff } = overrides;

    return computeLpFeeStateful(
      amount,
      depositChainId,
      hubPoolChainId,
      decimals,
      hubBalance,
      hubEquity,
      ethSpokeBalance,
      spokeTargets,
      baselineFee,
      gammaCutoff
    );
  }

  /**
   * Compute the entire system fee for a given amount. The system fee is the sum of the LP fee and the balancing fee.
   * @param depositChainId The chainId of the deposit
   * @param destinationChainId The chainId of the transaction
   * @param tokenSymbol The token to get the system fee for
   * @param amount The amount to get the system fee for
   * @param hubPoolBlockNumber The block number to get the system fee for
   * @param overrides The overrides to use for the LP fee calculation
   * @returns The system fee for the given token on the given chainId at the given block number
   */
  public computeSystemFee(
    depositChainId: number,
    destinationChainId: number,
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    overrides?: UBALPFeeOverride
  ): SystemFeeResult {
    const [lpFee, { balancingFee: depositBalancingFee }] = [
      this.computeLpFee(amount, depositChainId, destinationChainId, tokenSymbol, undefined, overrides),
      this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, depositChainId, UBAActionType.Deposit),
    ];
    return { lpFee, depositBalancingFee, systemFee: lpFee.add(depositBalancingFee) };
  }

  /**
   * Compute the entire UBA fee in the context of the UBA system for a given amount. The UBA fee is comprised of 7 return variables.
   * @param depositChain The chainId of the deposit
   * @param refundChain The chainId of the refund
   * @param tokenSymbol The token to get the relayer fee for
   * @param hubPoolTokenAddress The token address of the token on the hub pool chain
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param overrides The overrides to use for the LP fee calculation
   * @returns The UBA fee for the given token on the given chainId at the given block number
   */
  public getUBAFee(
    depositChain: number,
    refundChain: number,
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    overrides?: UBALPFeeOverride
  ): { relayerBalancingFee: BigNumber } & SystemFeeResult {
    const [relayerFee, systemFee] = [
      this.computeBalancingFee(tokenSymbol, amount, hubPoolBlockNumber, refundChain, UBAActionType.Refund),
      this.computeSystemFee(depositChain, refundChain, tokenSymbol, amount, hubPoolBlockNumber, overrides),
    ];
    return {
      relayerBalancingFee: relayerFee.balancingFee,
      ...systemFee,
    };
  }

  /**
   * Compute the entire UBA fee in the context of the UBA system for a given amount. The UBA fee is comprised of 7 return variables. This function is used to compute the UBA fee for a given amount on multiple refund chains.
   * The function returns a record of the UBA fee for each refund chain that is not too low.
   * @param depositChain The chainId of the deposit
   * @param refundChainCandidates The chainIds of the refund candidates
   * @param tokenSymbol The token to get the relayer fee for
   * @param amount The amount to get the relayer fee for
   * @param hubPoolBlockNumber The block number to get the relayer fee for
   * @param overrides The overrides to use for the LP fee calculation
   * @returns A record of the UBA fee for each refund chain that is not too low
   */
  public getUBAFeeFromCandidates(
    depositChain: number,
    refundChainCandidates: number[],
    tokenSymbol: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    overrides?: UBALPFeeOverride
  ): Record<number, RelayerFeeResult & SystemFeeResult> {
    const transformation = refundChainCandidates.map((refundChain) => {
      return [
        refundChain,
        this.getUBAFee(depositChain, refundChain, tokenSymbol, amount, hubPoolBlockNumber, overrides),
      ] as [number, RelayerFeeResult & SystemFeeResult];
    });
    return Object.fromEntries(transformation.filter(([, result]) => !result.amountTooLow));
  }

  public update(state?: { [chainId: number]: UBAChainState }): Promise<void> {
    if (state) {
      this.bundleStates = state;
    }
    this.isUpdated = true;
    return Promise.resolve();
  }
}
