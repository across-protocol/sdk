import winston from "winston";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { Address } from "@solana/kit";
import { DepositWithBlock, RelayerRefundExecution, SortableEvent, SlowFillLeaf, Log } from "../../interfaces";
import { getCurrentTime, bnZero, MakeOptional, EventSearchConfig } from "../../utils";
import { SpokePoolUpdate, SvmSpokePoolClient } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { EventOverrides } from "./MockEvents";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";
import { MockSvmCpiEventsClient } from "./MockSvmCpiEventsClient";
import { EventWithData, SvmCpiEventsClient, SVMEventNames, unwrapEventData } from "../../arch/svm";

// This class replaces internal SpokePoolClient functionality, enabling
// the user to bypass on-chain queries and inject events directly.
export class MockSvmSpokePoolClient extends SvmSpokePoolClient {
  public mockEventsClient: MockSvmCpiEventsClient;
  private destinationTokenForChainOverride: Record<number, string> = {};

  constructor(
    logger: winston.Logger,
    chainId: number,
    programId = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    deploymentBlock: number = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 },
    opts: { hubPoolClient: HubPoolClient | null } = { hubPoolClient: null }
  ) {
    super(
      logger,
      opts.hubPoolClient,
      chainId,
      BigInt(deploymentBlock),
      eventSearchConfig,
      null as unknown as SvmCpiEventsClient,
      programId,
      null as unknown as Address
    );
    this.mockEventsClient = new MockSvmCpiEventsClient();
    this.latestHeightSearched = deploymentBlock;
  }

  setConfigStoreClient(configStore?: AcrossConfigStoreClient): void {
    this.configStoreClient = configStore;
  }

  setDestinationTokenForChain(chainId: number, token: string): void {
    this.destinationTokenForChainOverride[chainId] = token;
  }

  getDestinationTokenForDeposit(deposit: DepositWithBlock): string {
    return this.destinationTokenForChainOverride[deposit.originChainId] ?? super.getDestinationTokenForDeposit(deposit);
  }

  setLatestBlockNumber(blockNumber: number): void {
    this.latestHeightSearched = blockNumber;
  }

  async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    const from = this.eventSearchConfig.from ?? this.deploymentBlock;
    const to = this.eventSearchConfig.to ? BigInt(this.eventSearchConfig.to) : undefined;

    // Get events from the mock event client.
    const events: EventWithData[][] = await Promise.all(
      eventsToQuery.map((eventName) => this.mockEventsClient.queryEvents(eventName as SVMEventNames, BigInt(from), to))
    );

    const eventsWithBlockNumber = events.map((eventList) =>
      eventList.map((event) => {
        return {
          txnRef: event.signature,
          blockNumber: Number(event.slot),
          txnIndex: 0,
          logIndex: 0,
          ...(unwrapEventData(event.data) as Record<string, unknown>),
        };
      })
    );

    return Promise.resolve({
      success: true,
      firstDepositId: bnZero,
      currentTime: getCurrentTime(),
      events: eventsWithBlockNumber,
      searchEndBlock: this.eventSearchConfig.to || this.latestHeightSearched,
    });
  }

  deposit(deposit: SvmSpokeClient.FundsDeposited & Partial<EventWithData>): EventWithData {
    return this.mockEventsClient.deposit(deposit);
  }

  fillRelay(fill: SvmSpokeClient.FilledRelay & Partial<EventWithData>): EventWithData {
    return this.mockEventsClient.fillRelay(fill);
  }

  requestSlowFill(request: SvmSpokeClient.RequestedSlowFill & Partial<EventWithData>): EventWithData {
    return this.mockEventsClient.requestSlowFill(request);
  }

  setTokensBridged(_tokensBridged: SvmSpokeClient.TokensBridged & Partial<EventWithData>): EventWithData {
    throw new Error("MockSvmSpokePoolClient#setTokensBridged not implemented");
  }

  executeSlowRelayLeaf(_leaf: Omit<SlowFillLeaf, "messageHash">): Log {
    throw new Error("MockSvmSpokePoolClient#executeV3SlowRelayLeaf not implemented");
  }

  executeRelayerRefundLeaf(_refund: RelayerRefundExecution & Partial<SortableEvent>): Log {
    throw new Error("MockSvmSpokePoolClient#executeRelayerRefundLeaf not implemented");
  }

  setEnableRoute(
    _originToken: string,
    _destinationChainId: number,
    _enabled: boolean,
    _overrides: EventOverrides = {}
  ): Log {
    throw new Error("MockSvmSpokePoolClient#setEnableRoute not implemented");
  }
}
