import assert from "assert";
import winston from "winston";
import { HubPoolClient, SpokePoolClient } from "..";
import { BaseUBAClient } from "./UBAClientBase";
import { updateUBAClient } from "./UBAClientUtilities";
import { UBAClientState } from "./UBAClientTypes";
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
  public async update(state?: UBAClientState, forceClientRefresh?: boolean): Promise<void> {
    const newState =
      state && Object.entries(state).length > 0
        ? state
        : await updateUBAClient(
            this.hubPoolClient,
            this.spokePoolClients,
            this.chainIdIndices,
            this.tokens,
            forceClientRefresh,
            this.maxBundleStates
          );
    await super.update(newState);
  }
  public get isUpdated(): boolean {
    return (
      this.hubPoolClient.configStoreClient.isUpdated &&
      this.hubPoolClient.isUpdated &&
      Object.values(this.spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated) &&
      this._isUpdated
    );
  }
  public set isUpdated(value: boolean) {
    this._isUpdated = value;
  }
}
