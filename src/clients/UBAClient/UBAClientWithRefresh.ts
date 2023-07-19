import assert from "assert";
import winston from "winston";
import { SpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { BaseUBAClient } from "./UBAClientBase";
import { getFeesForFlow, updateUBAClient } from "./UBAClientUtilities";
import { SystemFeeResult, UBAClientState } from "./UBAClientTypes";
import { UbaInflow } from "../../interfaces";
import { findLast } from "../../utils";
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
   * @notice Intended to be called by Relayer to set `realizedLpFeePct` for a deposit.
   */
  public computeSystemFeeForDeposit(deposit: UbaInflow): SystemFeeResult {
    const tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
    if (!tokenSymbol) throw new Error("No token symbol found");
    const relevantBundleStates = this.retrieveBundleStates(deposit.originChainId, tokenSymbol);
    const specificBundleState = findLast(
      relevantBundleStates,
      (bundleState) => bundleState.openingBlockNumberForSpokeChain <= deposit.blockNumber
    );
    if (!specificBundleState) {
      throw new Error(`No bundle states found for token ${tokenSymbol} on chain ${deposit.originChainId}`);
    }

    // If there are no flows in the bundle AFTER the balancingActionBlockNumber then its safer to throw an error
    // then risk returning an invalid Balancing fee because we're missing flows preceding the
    //  balancingActionBlockNumber.
    if (specificBundleState.closingBlockNumberForSpokeChain < deposit.blockNumber) {
      throw new Error("Bundle end block doesn't cover flow");
    }

    // Find matching flow in bundle state:
    const matchingFlow = specificBundleState.flows.find(({ flow }) => {
      // TODO: Is there more validation needed here? I assume no because the bundle states are already
      // sanitized on update()
      return flow.depositId === deposit.depositId;
    });
    if (!matchingFlow) {
      throw new Error("Found bundle state containing flow but no matching flow found for deposit");
    }

    return matchingFlow?.systemFee;
  }

  /**
   * This is meant to be called by the Fee Quoting API to give an indiciative fee, rather than an exact fee
   * for the next deposit.
   * @param amount
   * @param chainId
   * @param tokenSymbol
   */
  public getLatestFeesForDeposit(deposit: UbaInflow): {
    lpFee: BigNumber;
    relayerBalancingFee: BigNumber;
    depositBalancingFee: BigNumber;
  } {
    const tokenSymbol = this.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId)?.symbol;
    if (!tokenSymbol) throw new Error("No token symbol found");

    // Grab latest bundle state:
    const lastBundleState = this.retrieveLastBundleState(deposit.originChainId, tokenSymbol);
    if (!lastBundleState) {
      throw new Error("No bundle states in memory");
    }

    const { lpFee, depositBalancingFee, relayerBalancingFee } = getFeesForFlow(
      deposit,
      lastBundleState.flows.map(({ flow }) => flow),
      // We make an assumption that latest UBA config will be applied to the flow. This isn't necessarily true
      // if the current bundle is pending liveness. In that case we'd want to grab the config set at the
      // bundle start block. However because this function is designed to return an approximation, this is
      // a useful simplification.
      lastBundleState,
      deposit.originChainId,
      tokenSymbol
    );

    return {
      lpFee,
      depositBalancingFee,
      relayerBalancingFee,
    };
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
