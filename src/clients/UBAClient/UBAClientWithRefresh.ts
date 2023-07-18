import assert from "assert";
import winston from "winston";
import { HubPoolClient, SpokePoolClient } from "..";
import { BaseUBAClient } from "./UBAClientBase";
import { updateUBAClient } from "./UBAClientUtilities";
import { UBAChainState } from "./UBAClientTypes";
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
      return;
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
    return this.update(
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
    this._isUpdated = value;
  }
}
