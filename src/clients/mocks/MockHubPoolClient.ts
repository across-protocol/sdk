import winston from "winston";
import { BigNumber, Contract, Event } from "ethers";
import { randomAddress, assign, bnZero } from "../../utils";
import { L1Token, PendingRootBundle, RealizedLpFee } from "../../interfaces";
import { AcrossConfigStoreClient as ConfigStoreClient } from "../AcrossConfigStoreClient";
import { HubPoolClient, HubPoolUpdate, LpFeeRequest } from "../HubPoolClient";
import { EventManager, EventOverrides, getEventManager } from "./MockEvents";

const emptyRootBundle: PendingRootBundle = {
  poolRebalanceRoot: "",
  relayerRefundRoot: "",
  slowRelayRoot: "",
  proposer: "",
  unclaimedPoolRebalanceLeafCount: 0,
  challengePeriodEndTimestamp: 0,
  bundleEvaluationBlockNumbers: [],
  proposalBlockNumber: undefined,
};

export class MockHubPoolClient extends HubPoolClient {
  public rootBundleProposal = emptyRootBundle;
  private realizedLpFeePct: BigNumber = bnZero;
  private realizedLpFeePctOverride = false;

  private l1TokensMock: L1Token[] = []; // L1Tokens and their associated info.
  private tokenInfoToReturn: L1Token = { address: "", decimals: 0, symbol: "" };

  private spokePoolTokens: { [l1Token: string]: { [chainId: number]: string } } = {};

  private eventManager: EventManager;

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: ConfigStoreClient,
    deploymentBlock = 0,
    chainId = 1
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId);
    this.eventManager = getEventManager(chainId, this.eventSignatures, deploymentBlock);
  }

  setDefaultRealizedLpFeePct(fee: BigNumber): void {
    this.realizedLpFeePct = fee;
    this.realizedLpFeePctOverride = true;
  }

  clearDefaultRealizedLpFeePct(): void {
    this.realizedLpFeePctOverride = false;
  }

  async computeRealizedLpFeePct(deposit: LpFeeRequest): Promise<RealizedLpFee> {
    const { realizedLpFeePct, realizedLpFeePctOverride } = this;
    return realizedLpFeePctOverride
      ? { realizedLpFeePct, quoteBlock: 0 }
      : await super.computeRealizedLpFeePct(deposit);
  }
  async batchComputeRealizedLpFeePct(_deposits: LpFeeRequest[]): Promise<RealizedLpFee[]> {
    const { realizedLpFeePct, realizedLpFeePctOverride } = this;
    return realizedLpFeePctOverride
      ? _deposits.map(() => {
          return { realizedLpFeePct, quoteBlock: 0 };
        })
      : await super.batchComputeRealizedLpFeePct(_deposits);
  }

  setCrossChainContracts(chainId: number, contract: string, blockNumber = 0): void {
    assign(
      this.crossChainContracts,
      [chainId],
      [
        {
          spokePool: contract,
          blockNumber: blockNumber,
          transactionIndex: 0,
          logIndex: 0,
        },
      ]
    );
  }

  setLatestBlockNumber(blockNumber: number) {
    this.latestBlockSearched = blockNumber;
  }

  addL1Token(l1Token: L1Token) {
    this.l1TokensMock.push(l1Token);
  }

  getL1Tokens() {
    return this.l1TokensMock;
  }

  getTokenInfoForDeposit() {
    return this.tokenInfoToReturn;
  }

  setTokenMapping(l1Token: string, chainId: number, l2Token: string) {
    this.spokePoolTokens[l1Token] ??= {};
    this.spokePoolTokens[l1Token][chainId] = l2Token;
  }

  getL1TokenForL2TokenAtBlock(l2Token: string, chainId: number, blockNumber: number): string {
    const l1Token = Object.keys(this.spokePoolTokens).find(
      (l1Token) => this.spokePoolTokens[l1Token]?.[chainId] === l2Token
    );
    return l1Token ?? super.getL1TokenForL2TokenAtBlock(l2Token, chainId, blockNumber);
  }

  getL2TokenForL1TokenAtBlock(l1Token: string, chainId: number, blockNumber: number): string {
    const l2Token = this.spokePoolTokens[l1Token]?.[chainId];
    return l2Token ?? super.getL2TokenForL1TokenAtBlock(l1Token, chainId, blockNumber);
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
    return this.l1TokensMock.find((token) => token.address === l1Token);
  }

  setTokenInfoToReturn(tokenInfo: L1Token) {
    this.tokenInfoToReturn = tokenInfo;
  }

  _update(eventNames: string[]): Promise<HubPoolUpdate> {
    // Generate new "on chain" responses.
    const latestBlockSearched = this.eventManager.blockNumber;
    const currentTime = Math.floor(Date.now() / 1000);

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const _events: Event[][] = eventNames.map(() => []);
    this.eventManager
      .getEvents()
      .flat()
      .forEach((event) => {
        const idx = eventNames.indexOf(event.event as string);
        if (idx !== -1) {
          _events[idx].push(event);
        }
      });

    // Transform 2d-events array into a record.
    const events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, _events[idx]]));

    return Promise.resolve({
      success: true,
      currentTime,
      latestBlockSearched,
      pendingRootBundleProposal: this.rootBundleProposal,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockSearched,
    });
  }

  public readonly eventSignatures: Record<string, string> = {
    SetEnableDepositRoute: "uint256,uint256,address,bool",
    SetPoolRebalanceRoute: "uint256,address,address",
    ProposeRootBundle: "uint32,uint8,uint256[],bytes32,bytes32,bytes32,address",
    RootBundleExecuted: "uint256,uint256,uint256,address[],uint256[],int256[],int256[],address",
  };

  setPoolRebalanceRoute(
    destinationChainId: number,
    l1Token: string,
    destinationToken: string,
    overrides: EventOverrides = {}
  ): Event {
    const event = "SetPoolRebalanceRoute";

    const topics = [destinationChainId, l1Token, destinationToken];
    const args = {
      destinationChainId,
      l1Token,
      destinationToken,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.hubPool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: overrides.blockNumber,
    });
  }

  proposeRootBundle(
    challengePeriodEndTimestamp: number,
    poolRebalanceLeafCount: number,
    bundleEvaluationBlockNumbers: BigNumber[],
    poolRebalanceRoot?: string,
    relayerRefundRoot?: string,
    slowRelayRoot?: string,
    proposer?: string,
    overrides: EventOverrides = {}
  ): Event {
    const event = "ProposeRootBundle";

    poolRebalanceRoot ??= "XX";
    relayerRefundRoot ??= "XX";
    slowRelayRoot ??= "XX";
    proposer ??= randomAddress();

    const topics = [poolRebalanceRoot, relayerRefundRoot, proposer];
    const args = {
      challengePeriodEndTimestamp,
      poolRebalanceLeafCount,
      bundleEvaluationBlockNumbers,
      poolRebalanceRoot,
      relayerRefundRoot,
      slowRelayRoot,
      proposer,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.hubPool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: overrides.blockNumber,
    });
  }

  executeRootBundle(
    groupIndex: BigNumber,
    leafId: number,
    chainId: BigNumber,
    l1Tokens: string[],
    bundleLpFees: BigNumber[],
    netSendAmounts: BigNumber[],
    runningBalances: BigNumber[],
    caller?: string,
    overrides: EventOverrides = {}
  ): Event {
    const event = "RootBundleExecuted";

    caller ??= randomAddress();

    const topics = [leafId, chainId, caller];
    const args = {
      groupIndex,
      leafId,
      chainId,
      l1Tokens,
      bundleLpFees,
      netSendAmounts,
      runningBalances,
      caller,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.hubPool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: overrides.blockNumber,
    });
  }
}
