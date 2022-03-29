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
    providerUrl: string;
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
  private pollingTimers: Record<string, NodeJS.Timer[]> = {};

  constructor(
    config: TransfersHistoryClientParams,
    private logger = new Logger(),
    private transfersRepository = new TransfersRepository()
  ) {
    if (config.pollingIntervalSeconds) {
      this.pollingIntervalSeconds = config.pollingIntervalSeconds;
    }

    for (const chain of config.chains) {
      clientConfig.web3ProvidersUrls[chain.chainId] = chain.providerUrl;
      this.web3Providers[chain.chainId] = new providers.JsonRpcProvider(chain.providerUrl);
      this.spokePoolInstances[chain.chainId] = SpokePool__factory.connect(
        clientConfig.spokePools[chain.chainId].addr,
        this.web3Providers[chain.chainId]
      );
      this.eventsQueriers[chain.chainId] = new SpokePoolEventsQuerier(
        this.spokePoolInstances[chain.chainId],
        undefined,
        this.logger
      );
    }
  }

  public setLogLevel(level: LogLevel) {
    this.logger.setLevel(level);
  }

  public async startFetchingTransfers(depositorAddr: string) {
    this.initSpokePoolEventsQueryServices(depositorAddr);
    this.getEventsForDepositor(depositorAddr);
    const timer = setInterval(() => {
      this.getEventsForDepositor(depositorAddr);
    }, this.pollingIntervalSeconds * 1000);
    this.pollingTimers[depositorAddr] = [...(this.pollingTimers[depositorAddr] || []), timer];
  }

  public stopFetchingTransfers(depositorAddr: string) {
    (this.pollingTimers[depositorAddr] || []).map(timer => clearInterval(timer));
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

  private async getEventsForDepositor(depositorAddr: string) {
    await Promise.all(Object.values(this.eventsServices[depositorAddr]).map(eventService => eventService.getEvents()));
    this.transfersRepository.aggregateTransfers(depositorAddr);
    const eventData: TransfersUpdatedEventListenerParams = {
      depositorAddr,
      filledTransfersCount: this.transfersRepository.countFilledTransfers(depositorAddr),
      pendingTransfersCount: this.transfersRepository.countPendingTransfers(depositorAddr),
    };
    this.eventEmitter.emit(TransfersHistoryEvent.TransfersUpdated, eventData);
  }

  public getFilledTransfers(depositorAddr: string, limit?: number, offset?: number) {
    return this.transfersRepository.getFilledTransfers(depositorAddr, limit, offset);
  }

  public getPendingTransfers(depositorAddr: string, limit?: number, offset?: number) {
    return this.transfersRepository.getPendingTransfers(depositorAddr, limit, offset);
  }
}
