import EventEmitter from "events";
import { clientConfig } from "./config";
import { SpokePoolEventsQueryService } from "./services/SpokePoolEventsQueryService";
import { Logger, LogLevel } from "./adapters/logger";
import { providers } from "ethers";
import { SpokePool, SpokePool__factory } from "@across-protocol/contracts-v2";
import { ChainId } from "./adapters/web3/model";
import { SpokePoolEventsQuerier } from "./adapters/web3";
import { TransfersRepository } from "./adapters/db/transfers-repository";

export enum TransfersHistoryEvent {
  TransfersUpdated = "TransfersUpdated",
}

export type TransfersUpdatedEventListenerParams = {
  depositorAddr: string;
  filledTransfersCount: number;
  pendingTransfersCount: number;
};

export type TransfersUpdatedEventListener = (params: TransfersUpdatedEventListenerParams) => void;
export type TransfersHistoryClientEventListener = TransfersUpdatedEventListener;
export type TransfersHistoryClientParams = {
  chains: {
    chainId: ChainId;
    provider: providers.Provider;
    spokePoolContractAddr: string;
    lowerBoundBlockNumber?: number;
  }[];
  pollingIntervalSeconds?: number;
};

export class TransfersHistoryClient {
  private eventEmitter = new EventEmitter();
  private web3Providers: Record<ChainId, providers.Provider> = {};
  private spokePoolInstances: Record<ChainId, SpokePool> = {};
  private eventsQueriers: Record<ChainId, SpokePoolEventsQuerier> = {};
  private eventsServices: Record<string, Record<ChainId, SpokePoolEventsQueryService>> = {};
  private pollingIntervalSeconds: number = 15;
  private pollingTimers: Record<string, NodeJS.Timer> = {};
  private fetchingState: Record<string, "started" | "stopped"> = {};

  constructor(
    config: TransfersHistoryClientParams,
    private logger = new Logger(),
    private transfersRepository = new TransfersRepository()
  ) {
    if (typeof config.pollingIntervalSeconds === "number") {
      this.pollingIntervalSeconds = config.pollingIntervalSeconds;
    }

    for (const chain of config.chains) {
      this.web3Providers[chain.chainId] = chain.provider;
      this.spokePoolInstances[chain.chainId] = SpokePool__factory.connect(
        chain.spokePoolContractAddr,
        this.web3Providers[chain.chainId]
      );
      this.eventsQueriers[chain.chainId] = new SpokePoolEventsQuerier(
        this.spokePoolInstances[chain.chainId],
        undefined,
        this.logger
      );
      clientConfig.spokePools[chain.chainId] = { lowerBoundBlockNumber: chain.lowerBoundBlockNumber || 0 };
    }
  }

  public setLogLevel(level: LogLevel) {
    this.logger.setLevel(level);
  }

  public async startFetchingTransfers(depositorAddr: string) {
    this.initSpokePoolEventsQueryServices(depositorAddr);
    this.getEventsForDepositor(depositorAddr);
    // mark that we started fetching events for depositor address
    this.fetchingState[depositorAddr] = "started";
    // add polling if user didn't opted out for polling
    if (this.pollingIntervalSeconds > 0) {
      let timer = this.pollingTimers[depositorAddr];

      // prevent triggering multiple polling intervals for the same address
      if (timer) throw new Error(`Address ${depositorAddr} is already monitored`);

      timer = setInterval(() => {
        this.getEventsForDepositor(depositorAddr);
      }, this.pollingIntervalSeconds * 1000);
      this.pollingTimers[depositorAddr] = timer;
    }
  }

  public stopFetchingTransfers(depositorAddr: string) {
    const timer = this.pollingTimers[depositorAddr];
    // mark that the fetching stopped for depositor address
    this.fetchingState[depositorAddr] = "stopped";
    if (timer) {
      clearInterval(timer);
      delete this.pollingTimers[depositorAddr];
    }
  }

  public on(event: TransfersHistoryEvent, cb: TransfersHistoryClientEventListener) {
    this.eventEmitter.on(event, cb);
  }

  private initSpokePoolEventsQueryServices(depositorAddr: string) {
    const chainIds = Object.keys(this.spokePoolInstances).map(chainId => parseInt(chainId));

    for (const chainId of chainIds) {
      if (!this.eventsServices[depositorAddr]) {
        this.eventsServices[depositorAddr] = {};
      }

      if (!this.eventsServices[depositorAddr][chainId]) {
        this.eventsServices[depositorAddr][chainId] = new SpokePoolEventsQueryService(
          chainId,
          this.web3Providers[chainId],
          this.eventsQueriers[chainId],
          this.logger,
          this.transfersRepository,
          depositorAddr
        );
      }
    }
  }

  private async getEventsForDepositor(depositorAddr: string) {
    await Promise.all(Object.values(this.eventsServices[depositorAddr]).map(eventService => eventService.getEvents()));
    this.transfersRepository.aggregateTransfers(depositorAddr);
    const eventData: TransfersUpdatedEventListenerParams = {
      depositorAddr,
      filledTransfersCount: this.transfersRepository.countFilledTransfers(depositorAddr),
      pendingTransfersCount: this.transfersRepository.countPendingTransfers(depositorAddr),
    };

    // emit event only if the fetching wasn't stopped for depositor address.
    // this is to prevent events from being triggered after the fetching was stopped
    if (this.fetchingState[depositorAddr] === "started") {
      this.eventEmitter.emit(TransfersHistoryEvent.TransfersUpdated, eventData);
    }
  }

  public getFilledTransfers(depositorAddr: string, limit?: number, offset?: number) {
    return this.transfersRepository.getFilledTransfers(depositorAddr, limit, offset);
  }

  public getPendingTransfers(depositorAddr: string, limit?: number, offset?: number) {
    return this.transfersRepository.getPendingTransfers(depositorAddr, limit, offset);
  }
}
