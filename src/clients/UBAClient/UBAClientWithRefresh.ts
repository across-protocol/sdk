import assert from "assert";
import winston from "winston";
import { HubPoolClient, SpokePoolClient } from "..";
import { BaseUBAClient } from "./UBAClientBase";
import { getLpFeeParams, updateUBAClient } from "./UBAClientUtilities";
import { SystemFeeResult, UBAChainState } from "./UBAClientTypes";
import { BigNumber } from "ethers";
export class UBAClientWithRefresh extends BaseUBAClient {
  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    readonly chainIdIndices: number[],
    readonly tokens: string[],
    protected readonly hubPoolClient: HubPoolClient,
    public readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly maxBundleStates: number,
    readonly logger?: winston.Logger
  ) {
    super(chainIdIndices, tokens, maxBundleStates, hubPoolClient.chainId, logger);
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
  }

  /**
   * Updates the clients and UBAFeeCalculators.
   * @param forceRefresh An optional boolean to force a refresh of the clients.
   */
  public async update(state: { [chainId: number]: UBAChainState }, forceClientRefresh?: boolean): Promise<void> {
    if (state) {
      await super.update(state);
    }
    // Update the clients if the necessary clients have not been updated at least once.
    // Also update if forceClientRefresh is true.
    if (forceClientRefresh || !this.isUpdated) {
      // Update the Across config store
      await this.hubPoolClient.configStoreClient.update();
      // Update the HubPool
      await this.hubPoolClient.update();
      // Update the SpokePools
      await Promise.all(Object.values(this.spokePoolClients).map(async (spokePoolClient) => spokePoolClient.update()));
    }
    this.update(
      await updateUBAClient(
        this.hubPoolClient,
        this.spokePoolClients,
        this.chainIdIndices,
        this.tokens,
        forceClientRefresh,
        this.maxBundleStates
      )
    );
  }

  /**
   * Compute the realized LP fee for a given amount.
   * @param hubPoolTokenAddress The L1 token address to get the LP fee
   * @param depositChainId The chainId of the deposit
   * @param refundChainId The chainId of the refund
   * @param amount The amount that is being deposited
   * @param hubPoolClient A hub pool client instance to query the hub pool
   * @param spokePoolClients A mapping of spoke chainIds to spoke pool clients
   * @returns The realized LP fee for the given token on the given chainId at the given block number
   */
  public async computeRefreshedLpFee(
    hubPoolBlockNumber: number,
    amount: BigNumber,
    depositChainId: number,
    refundChainId: number,
    tokenSymbol: string
  ): Promise<BigNumber> {
    const { hubBalance, hubLiquidReserves } = await getLpFeeParams(hubPoolBlockNumber, tokenSymbol, this.hubPoolClient);
    return super.computeLpFee(
      hubPoolBlockNumber,
      amount,
      depositChainId,
      refundChainId,
      tokenSymbol,
      hubBalance,
      hubLiquidReserves
    );
  }

  public async computeRefreshedSystemFee(
    hubPoolBlockNumber: number,
    amount: BigNumber,
    depositChainId: number,
    destinationChainId: number,
    tokenSymbol: string
  ): Promise<SystemFeeResult> {
    const { hubBalance, hubLiquidReserves } = await getLpFeeParams(hubPoolBlockNumber, tokenSymbol, this.hubPoolClient);
    return super.computeSystemFee(
      hubPoolBlockNumber,
      amount,
      depositChainId,
      destinationChainId,
      tokenSymbol,
      hubBalance,
      hubLiquidReserves
    );
  }

  public get isUpdated(): boolean {
    return (
      this.hubPoolClient.configStoreClient.isUpdated &&
      this.hubPoolClient.isUpdated &&
      Object.values(this.spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated) &&
      this.isUpdated
    );
  }
}
