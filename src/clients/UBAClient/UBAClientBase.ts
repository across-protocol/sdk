import winston from "winston";
import { UbaFlow } from "../../interfaces";
import { BigNumber } from "ethers";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import {
  BalancingFeeReturnType,
  SystemFeeResult,
  UBABundleState,
  UBAClientState,
  ModifiedUBAFlow,
} from "./UBAClientTypes";
import { computeLpFeeStateful } from "./UBAClientUtilities";
import { findLast } from "../../utils/ArrayUtils";
import { analog } from "../../UBAFeeCalculator";
import { BaseAbstractClient } from "../BaseAbstractClient";
import { TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2";

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
   * @returns
   */
  public retrieveBundleStateForBlock(
    hubPoolBlockNumber: number,
    chainId: number,
    tokenSymbol: string
  ): UBABundleState | undefined {
    const sortedDescendingBundleStates = [
      ...this.retrieveBundleStates(chainId, tokenSymbol).sort(
        (a, b) => b.openingBlockNumberForSpokeChain - a.openingBlockNumberForSpokeChain
      ),
    ];
    return sortedDescendingBundleStates.find(
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
   * Compute the LP fee for a given amount. The LP fee is the fee paid to the LP for providing liquidity and
   * it is based on the Hub balances and Spoke target configs at the `hubPoolBlockNumber`.
   * @param hubPoolBlockNumber The block number to get the LP fee for
   * @returns The LP fee for the given token on the given chainId at the given block number
   */
  protected computeLpFee(
    hubPoolBlockNumber: number,
    amount: BigNumber,
    depositChainId: number,
    refundChainId: number,
    tokenSymbol: string,
    hubBalance: BigNumber,
    hubLiquidReserves: BigNumber
  ): BigNumber {
    // It doesn't actually matter which `chainId` we query the bundle state for. Its only important
    // that we return the bundle config for the correct token that was used at the time of the hubPoolBlockNumber.
    // To be safe, use the hub chain since its guaranteed to have a bundle state in memory.
    const bundleState = this.retrieveBundleStateForBlock(hubPoolBlockNumber, this.hubChainId, tokenSymbol);
    if (!bundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} before block ${hubPoolBlockNumber}`);
    }
    const tokenMappingLookup = (
      TOKEN_SYMBOLS_MAP as Record<string, { addresses: { [x: number]: string }; decimals: number; symbol: string }>
    )[tokenSymbol];
    const ubaConfigForBundle = bundleState.config;
    const cumulativeSpokeTargets = ubaConfigForBundle.getTotalSpokeTargetBalanceForComputingLpFee(
      tokenMappingLookup.symbol
    );

    return computeLpFeeStateful(
      amount,
      depositChainId,
      refundChainId,
      this.hubChainId,
      tokenMappingLookup.decimals,
      hubBalance,
      hubLiquidReserves,
      cumulativeSpokeTargets,
      bundleState.config.getBaselineFee(refundChainId ?? depositChainId, depositChainId),
      bundleState.config.getLpGammaFunctionTuples(depositChainId)
    );
  }

  /**
   * Compute the system fee for a given amount. The system fee is the sum of the LP fee and the balancing fee.
   * @param depositChainId The chainId of the deposit
   * @param destinationChainId The chainId of the transaction
   * @param tokenSymbol The token to get the system fee for
   * @param amount The amount to get the system fee for
   * @param hubPoolBlockNumber The block number to get the system fee for
   * @param overrides The overrides to use for the LP fee calculation
   * @returns The system fee for the given token on the given chainId at the given block number
   */
  public computeSystemFee(
    hubPoolBlockNumber: number,
    amount: BigNumber,
    depositChainId: number,
    destinationChainId: number,
    tokenSymbol: string,
    hubBalance: BigNumber,
    hubLiquidReserves: BigNumber
  ): SystemFeeResult {
    const lpFee = this.computeLpFee(
      hubPoolBlockNumber,
      amount,
      depositChainId,
      destinationChainId,
      tokenSymbol,
      hubBalance,
      hubLiquidReserves
    );
    const { balancingFee: depositBalancingFee } = this.computeBalancingFee(
      tokenSymbol,
      amount,
      hubPoolBlockNumber,
      depositChainId,
      UBAActionType.Deposit
    );
    return { lpFee, depositBalancingFee, systemFee: lpFee.add(depositBalancingFee) };
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
