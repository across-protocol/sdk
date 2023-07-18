import assert from "assert";
import winston from "winston";
import { SpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import { BaseUBAClient } from "./UBAClientBase";
import { computeLpFeeStateful, getUBAFeeConfig, updateUBAClient } from "./UBAClientUtilities";
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
    tokenSymbol: string
  ): SystemFeeResult {
    // Grab bundle config at block for the deposit chain.
    const bundleConfig = getUBAFeeConfig(this.hubPoolClient, depositChainId, tokenSymbol, hubPoolBlockNumber);
    const lpFee = computeLpFeeStateful(
      bundleConfig.getBaselineFee(destinationChainId ?? depositChainId, depositChainId)
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
  public get isUpdated(): boolean {
    return (
      this.hubPoolClient.configStoreClient.isUpdated &&
      this.hubPoolClient.isUpdated &&
      Object.values(this.spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated) &&
      this.isUpdated
    );
  }
  public set isUpdated(value: boolean) {
    this.isUpdated = value;
  }
}
