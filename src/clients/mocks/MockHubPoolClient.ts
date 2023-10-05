import { BigNumber, Contract, Event } from "ethers";
import winston from "winston";
import { randomAddress, assign } from "../../utils";
import { DepositWithBlock, L1Token, PendingRootBundle } from "../../interfaces";
import { AcrossConfigStoreClient as ConfigStoreClient } from "../AcrossConfigStoreClient";
import { HubPoolClient, HubPoolUpdate } from "../HubPoolClient";
import { EventManager, getEventManager } from "./MockEvents";

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

  private events: Event[] = [];

  private l1TokensMock: L1Token[] = []; // L1Tokens and their associated info.
  private tokenInfoToReturn: L1Token = { address: "", decimals: 0, symbol: "" };
  private returnedL1TokenForDeposit: string | undefined = undefined;
  private returnedL2TokenForDeposit: { [chainId: number]: string } = {};

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
    this.latestBlockNumber = blockNumber;
  }

  addEvent(event: Event): void {
    this.events.push(event);
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

  getL1TokenForL2TokenAtBlock(l2Token: string, destinationChainId: number, latestHubBlock?: number): string {
    return super.getL1TokenForL2TokenAtBlock(l2Token, destinationChainId, latestHubBlock);
  }

  getL2TokenForL1TokenAtBlock(l1Token: string, destinationChainId: number, latestHubBlock?: number): string {
    return super.getL2TokenForL1TokenAtBlock(l1Token, destinationChainId, latestHubBlock);
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
    return this.l1TokensMock.find((token) => token.address === l1Token);
  }

  setTokenInfoToReturn(tokenInfo: L1Token) {
    this.tokenInfoToReturn = tokenInfo;
  }

  setReturnedL1TokenForDeposit(l1Token: string) {
    this.returnedL1TokenForDeposit = l1Token;
  }

  getL1TokenForDeposit(event: Pick<DepositWithBlock, "blockNumber" | "originToken" | "originChainId">): string {
    return this.returnedL1TokenForDeposit ?? super.getL1TokenForDeposit(event);
  }

  setReturnedL2TokenForDeposit(chainId: number, l2Token: string) {
    this.returnedL2TokenForDeposit[chainId] = l2Token;
  }

  getL2TokenForDeposit(
    chainId: number,
    event: Pick<DepositWithBlock, "blockNumber" | "originToken" | "originChainId">
  ): string {
    return this.returnedL2TokenForDeposit[chainId] ?? super.getL2TokenForDeposit(chainId, event);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getL1TokenInfoForL2Token(l2Token: string, _chain: number): L1Token {
    return this.getTokenInfoForL1Token(l2Token) ?? this.tokenInfoToReturn;
  }

  _update(eventNames: string[]): Promise<HubPoolUpdate> {
    // Generate new "on chain" responses.
    const latestBlockNumber = this.eventManager.blockNumber;
    const currentTime = Math.floor(Date.now() / 1000);

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const _events: Event[][] = eventNames.map(() => []);
    this.events.flat().forEach((event) => {
      const idx = eventNames.indexOf(event.event as string);
      if (idx !== -1) {
        _events[idx].push(event);
      }
    });
    this.events = [];

    // Transform 2d-events array into a record.
    const events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, _events[idx]]));

    return Promise.resolve({
      success: true,
      currentTime,
      latestBlockNumber,
      pendingRootBundleProposal: this.rootBundleProposal,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
    });
  }

  public readonly eventSignatures: Record<string, string> = {
    SetEnableDepositRoute: "uint256,uint256,address,bool",
    SetPoolRebalanceRoute: "uint256,address,address",
    ProposeRootBundle: "uint32,uint8,uint256[],bytes32,bytes32,bytes32,address",
    RootBundleExecuted: "uint256,uint256,uint256,address[],uint256[],int256[],int256[],address",
  };

  setPoolRebalanceRoute(destinationChainId: number, l1Token: string, destinationToken: string): Event {
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
    });
  }

  proposeRootBundle(
    challengePeriodEndTimestamp: number,
    poolRebalanceLeafCount: number,
    bundleEvaluationBlockNumbers: BigNumber[],
    poolRebalanceRoot?: string,
    relayerRefundRoot?: string,
    slowRelayRoot?: string,
    proposer?: string
  ): Event {
    const event = "ProposeRootBundle";

    poolRebalanceRoot = poolRebalanceRoot ?? "XX";
    relayerRefundRoot = relayerRefundRoot ?? "XX";
    slowRelayRoot = slowRelayRoot ?? "XX";
    proposer = proposer ?? randomAddress();

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
    caller?: string
  ): Event {
    const event = "RootBundleExecuted";

    caller = caller ?? randomAddress();

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
    });
  }
}
