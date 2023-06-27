import assert from "assert";
import winston from "winston";
import { BigNumber } from "ethers";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "..";
import { isDefined, sortEventsAscending } from "../../utils";
import { BaseUBAClient, RequestValidReturnType } from "./UBAClientAbstract";
import { UBAFeeSpokeCalculator } from "../../UBAFeeCalculator";
import { computeLpFeeForRefresh, getUBAFeeConfig } from "./UBAClientUtilities";
import { RelayFeeCalculator, RelayFeeCalculatorConfig, RelayerFeeDetails } from "../../relayFeeCalculator";
export class UBAClientWithRefresh extends BaseUBAClient {
  /**
   * The RelayFeeCalculator is used to compute the relayer fee for a given amount of tokens.
   */
  private readonly relayCalculator: RelayFeeCalculator;

  // @dev chainIdIndices supports indexing members of root bundle proposals submitted to the HubPool.
  //      It must include the complete set of chain IDs ever supported by the HubPool.
  // @dev SpokePoolClients may be a subset of the SpokePools that have been deployed.
  constructor(
    readonly chainIdIndices: number[],
    private readonly hubPoolClient: HubPoolClient,
    private readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    private readonly relayerConfiguration: RelayFeeCalculatorConfig,
    readonly logger?: winston.Logger
  ) {
    super(chainIdIndices, logger);
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(spokePoolClients).length > 0, "No SpokePools provided");
    this.relayCalculator = new RelayFeeCalculator(this.relayerConfiguration);
  }

  /**
   * Updates the clients and UBAFeeCalculators.
   * @param forceRefresh An optional boolean to force a refresh of the clients.
   */
  public async update(forceClientRefresh?: boolean): Promise<void> {
    // Update the clients if the necessary clients have not been updated at least once.
    // Also update if forceClientRefresh is true.
    if (forceClientRefresh || !this.areNecessaryClientsUpdated()) {
      // Update the Across config store
      await this.hubPoolClient.configStoreClient.update();
      // Update the HubPool
      await this.hubPoolClient.update();
      // Update the SpokePools
      await Promise.all(Object.values(this.spokePoolClients).map(async (spokePoolClient) => spokePoolClient.update()));
    }
    // Update the UBAFeeCalculators
    await Promise.all(
      Object.entries(this.spokeUBAFeeCalculators).flatMap(([chainId, spokeUBAFeeCalculator]) =>
        Object.keys(spokeUBAFeeCalculator).map((token) =>
          this.instantiateUBAFeeCalculator(parseInt(chainId), token, this.hubPoolClient.latestBlockNumber ?? 0)
        )
      )
    );
  }

  /**
   * Performs and assert that the necessary clients have been updated at least once.
   */
  protected assertNecessaryClientsUpdated(): void {
    assert(this.areNecessaryClientsUpdated(), "UBAClientWithRefresh: Clients not updated");
  }

  /**
   * Verifies that the necessary clients have been updated at least once.
   * @returns true if all necessary clients have been updated at least once.
   */
  protected areNecessaryClientsUpdated(): boolean {
    return (
      this.hubPoolClient.configStoreClient.isUpdated &&
      this.hubPoolClient.isUpdated &&
      Object.values(this.spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated)
    );
  }

  protected resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    this.assertNecessaryClientsUpdated();
    return this.hubPoolClient.getLatestBundleEndBlockForChain(this.chainIdIndices, blockNumber, chainId);
  }

  public getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): { blockNumber: number; spokePoolBalance: BigNumber } {
    if (!isDefined(hubPoolBlockNumber)) {
      this.assertNecessaryClientsUpdated();
      // todo: Fix this type assertion.
      hubPoolBlockNumber = this.hubPoolClient.latestBlockNumber as number;
    }

    const hubPoolToken = this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, spokePoolToken, hubPoolBlockNumber);
    if (!isDefined(hubPoolToken)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }

    const spokePoolClient = this.spokePoolClients[chainId];
    const prevEndBlock = this.resolveClosingBlockNumber(chainId, hubPoolBlockNumber);
    let blockNumber = spokePoolClient.deploymentBlock;
    if (prevEndBlock > blockNumber) {
      blockNumber = prevEndBlock + 1;
      assert(blockNumber <= spokePoolClient.latestBlockNumber);
    }
    const { runningBalance: spokePoolBalance } = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(
      hubPoolBlockNumber,
      chainId,
      hubPoolToken
    );

    return { blockNumber, spokePoolBalance };
  }

  public getFlows(chainId: number, fromBlock?: number, toBlock?: number): UbaFlow[] {
    this.assertNecessaryClientsUpdated();
    const spokePoolClient = this.spokePoolClients[chainId];

    fromBlock = fromBlock ?? spokePoolClient.deploymentBlock;
    toBlock = toBlock ?? spokePoolClient.latestBlockNumber;

    // @todo: Fix these type assertions.
    const deposits: UbaFlow[] = spokePoolClient
      .getDeposits()
      .filter(
        (deposit: DepositWithBlock) =>
          deposit.blockNumber >= (fromBlock as number) && deposit.blockNumber <= (toBlock as number)
      );

    // Filter out:
    // - Fills that request refunds on a different chain.
    // - Subsequent fills after an initial partial fill.
    // - Slow fills.
    const fills: UbaFlow[] = spokePoolClient.getFills().filter((fill: FillWithBlock) => {
      const result =
        fill.repaymentChainId === spokePoolClient.chainId &&
        fill.fillAmount.eq(fill.totalFilledAmount) &&
        fill.updatableRelayData.isSlowRelay === false &&
        fill.blockNumber > (fromBlock as number) &&
        fill.blockNumber < (toBlock as number);
      return result;
    });

    const refundRequests: UbaFlow[] = spokePoolClient.getRefundRequests(fromBlock, toBlock).filter((refundRequest) => {
      const result = this.refundRequestIsValid(chainId, refundRequest);
      if (!result.valid && this.logger !== undefined) {
        this.logger.info({
          at: "UBAClient::getFlows",
          message: `Excluding RefundRequest on chain ${chainId}`,
          reason: result.reason,
          refundRequest,
        });
      }

      return result.valid;
    });

    // This is probably more expensive than we'd like... @todo: optimise.
    const flows = sortEventsAscending(deposits.concat(fills).concat(refundRequests));

    return flows;
  }

  public refundRequestIsValid(chainId: number, refundRequest: RefundRequestWithBlock): RequestValidReturnType {
    this.assertNecessaryClientsUpdated();
    const { relayer, amount, refundToken, depositId, originChainId, destinationChainId, realizedLpFeePct, fillBlock } =
      refundRequest;

    if (!this.chainIdIndices.includes(originChainId)) {
      return { valid: false, reason: "Invalid originChainId" };
    }
    const originSpoke = this.spokePoolClients[originChainId];

    if (!this.chainIdIndices.includes(destinationChainId) || destinationChainId === chainId) {
      return { valid: false, reason: "Invalid destinationChainId" };
    }
    const destSpoke = this.spokePoolClients[destinationChainId];

    if (fillBlock.lt(destSpoke.deploymentBlock) || fillBlock.gt(destSpoke.latestBlockNumber)) {
      return {
        valid: false,
        reason:
          `FillBlock (${fillBlock} out of SpokePool range` +
          ` [${destSpoke.deploymentBlock}, ${destSpoke.latestBlockNumber}]`,
      };
    }

    // Validate relayer and depositId.
    const fill = destSpoke.getFillsForRelayer(relayer).find((fill) => {
      // prettier-ignore
      return (
        fill.depositId === depositId
        && fill.originChainId === originChainId
        && fill.destinationChainId === destinationChainId
        && fill.amount.eq(amount)
        && fill.realizedLpFeePct.eq(realizedLpFeePct)
        && fill.blockNumber === fillBlock.toNumber()
      );
    });
    if (!isDefined(fill)) {
      return { valid: false, reason: "Unable to find matching fill" };
    }

    const deposit = originSpoke.getDepositForFill(fill);
    if (!isDefined(deposit)) {
      return { valid: false, reason: "Unable to find matching deposit" };
    }

    // Verify that the refundToken maps to a known HubPool token.
    // Note: the refundToken must be valid at the time of the Fill *and* the RefundRequest.
    // @todo: Resolve to the HubPool block number at the time of the RefundRequest ?
    const hubPoolBlockNumber = this.hubPoolClient.latestBlockNumber ?? this.hubPoolClient.deploymentBlock - 1;
    try {
      this.hubPoolClient.getL1TokenCounterpartAtBlock(chainId, refundToken, hubPoolBlockNumber);
    } catch {
      return { valid: false, reason: `Refund token unknown at HubPool block ${hubPoolBlockNumber}` };
    }

    return { valid: true };
  }

  protected async instantiateUBAFeeCalculator(chainId: number, token: string, fromBlock: number): Promise<void> {
    this.assertNecessaryClientsUpdated();
    if (!isDefined(this.spokeUBAFeeCalculators[chainId]?.[token])) {
      const spokeFeeCalculator = new UBAFeeSpokeCalculator(
        chainId,
        token,
        this.getFlows(chainId, fromBlock),
        0,
        await getUBAFeeConfig(chainId, token)
      );
      this.spokeUBAFeeCalculators[chainId] = this.spokeUBAFeeCalculators[chainId] ?? {};
      this.spokeUBAFeeCalculators[chainId][token] = spokeFeeCalculator;
    }
  }
  protected async computeLpFee(
    hubPoolTokenAddress: string,
    depositChainId: number,
    destinationChainId: number,
    amount: BigNumber
  ): Promise<BigNumber> {
    this.assertNecessaryClientsUpdated();
    const ubaConfig = await getUBAFeeConfig(depositChainId, hubPoolTokenAddress);
    return computeLpFeeForRefresh(
      hubPoolTokenAddress,
      depositChainId,
      destinationChainId,
      amount,
      this.hubPoolClient,
      this.spokePoolClients,
      ubaConfig.getBaselineFee(destinationChainId, depositChainId),
      ubaConfig.getLpGammaFunctionTuples(depositChainId)
    );
  }

  protected async computeRelayerFees(
    tokenSymbol: string,
    amount: BigNumber,
    depositChainId: number,
    refundChainId: number,
    tokenPrice?: number
  ): Promise<RelayerFeeDetails> {
    this.assertNecessaryClientsUpdated();
    return this.relayCalculator.relayerFeeDetails(
      amount,
      tokenSymbol,
      tokenPrice,
      depositChainId.toString(),
      refundChainId.toString()
    );
  }
}
