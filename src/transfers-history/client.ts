import EventEmitter from "events";
import { clientConfig } from "./config";
import { SpokePoolEventsQueryService } from "./services/SpokePoolEventsQueryService";
import { Logger, LogLevel } from "./adapters/logger";
import { BigNumber, providers } from "ethers";
import { ChainId } from "./adapters/web3/model";
import { SpokePoolEventsQuerier } from "./adapters/web3";
import { TransfersRepository } from "./adapters/db/transfers-repository";
import {
  SpokePool,
  SpokePool__factory,
  FilledRelayEvent,
  FundsDepositedEvent,
  RequestedSpeedUpDepositEvent,
} from "../typechain";
import { Transfer } from "./model";

export enum TransfersHistoryEvent {
  TransfersUpdated = "TransfersUpdated",
}

export type TransfersUpdatedEventListenerParams = {
  depositorAddr: string;
  filledTransfersCount: number;
  pendingTransfersCount: number;
};

export type TrackableAddress = "all" | string;

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
  private pollingIntervalSeconds = 15;
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

  public async startFetchingTransfers(depositorAddr: TrackableAddress) {
    this.fetchingState[depositorAddr] = "started";
    this.initSpokePoolEventsQueryServices(depositorAddr);
    await this.getEventsForDepositor(depositorAddr);
    // mark that we started fetching events for depositor address
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

  private initSpokePoolEventsQueryServices(depositorAddr: TrackableAddress) {
    const chainIds = Object.keys(this.spokePoolInstances).map((chainId) => parseInt(chainId));

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
          depositorAddr !== "all" ? depositorAddr : undefined
        );
      }
    }
  }

  private async getEventsForDepositor(depositorAddr: TrackableAddress) {
    // query all chains to get the events for the depositor address
    const events = await Promise.all(
      Object.values(this.eventsServices[depositorAddr]).map((eventService) => eventService.getEvents())
    );
    const depositEvents = events
      .flat()
      .reduce((acc, val) => [...acc, ...val.depositEvents], [] as FundsDepositedEvent[]);
    const filledRelayEvents = events
      .flat()
      .reduce((acc, val) => [...acc, ...val.filledRelayEvents], [] as FilledRelayEvent[]);
    const speedUpDepositEvents = events.flat().reduce(
      (acc, val) => [
        ...acc,
        ...val.speedUpDepositEvents.map((event) => ({
          ...event,
          // we have to enrich the event with this information in order to determine
          // which exact `transfer` needs to be updated.
          emittedFromChainId: val.emittedFromChainId,
        })),
      ],
      [] as Array<RequestedSpeedUpDepositEvent & { emittedFromChainId: number }>
    );
    const blockTimestampMap = events
      .flat()
      .reduce((acc, val) => ({ ...acc, ...val.blockTimestampMap }), {} as { [blockNumber: number]: number });

    depositEvents.map((e) => this.insertFundsDepositedEvent(e, blockTimestampMap[e.blockNumber]));
    filledRelayEvents.map((e) => this.insertFilledRelayEvent(e));
    speedUpDepositEvents.map((e) => this.handleSpeedUpDepositEvent(e, blockTimestampMap[e.blockNumber]));
    this.transfersRepository.aggregateTransfers();

    const filledTransfersCount =
      depositorAddr === "all"
        ? this.transfersRepository.countAllFilledTransfers()
        : this.transfersRepository.countFilledTransfers(depositorAddr);
    const pendingTransfersCount =
      depositorAddr === "all"
        ? this.transfersRepository.countAllPendingTransfers()
        : this.transfersRepository.countPendingTransfers(depositorAddr);

    const eventData: TransfersUpdatedEventListenerParams = {
      depositorAddr,
      filledTransfersCount,
      pendingTransfersCount,
    };

    // emit event only if the fetching wasn't stopped for depositor address.
    // this is to prevent events from being triggered after the fetching was stopped
    if (this.fetchingState[depositorAddr] === "started") {
      this.eventEmitter.emit(TransfersHistoryEvent.TransfersUpdated, eventData);
    }
  }

  private insertFundsDepositedEvent(event: FundsDepositedEvent, timestamp: number) {
    const { args, transactionHash } = event;
    const { amount, originToken, destinationChainId, depositId, depositor, originChainId, relayerFeePct } = args;
    const transfer: Transfer = {
      amount: BigNumber.from(amount),
      assetAddr: originToken,
      depositId: depositId,
      depositTime: timestamp,
      depositTxHash: transactionHash,
      destinationChainId: destinationChainId.toNumber(),
      filled: BigNumber.from("0"),
      sourceChainId: originChainId.toNumber(),
      status: "pending",
      fillTxs: [],
      initialRelayerFeePct: relayerFeePct,
      currentRelayerFeePct: relayerFeePct,
      speedUps: [],
    };
    this.transfersRepository.insertTransfer(originChainId.toNumber(), depositor, depositId, transfer);
  }

  private insertFilledRelayEvent(event: FilledRelayEvent) {
    const { args, transactionHash } = event;
    const { totalFilledAmount, depositor, depositId, originChainId, relayerFeePct } = args;
    this.transfersRepository.updateFilledAmount(
      originChainId.toNumber(),
      depositor,
      depositId,
      totalFilledAmount,
      transactionHash,
      relayerFeePct
    );
  }

  private handleSpeedUpDepositEvent(
    event: RequestedSpeedUpDepositEvent & { emittedFromChainId: number },
    timestamp: number
  ) {
    const { args, transactionHash, emittedFromChainId } = event;
    const { newRelayerFeePct, depositor, depositId } = args;
    this.transfersRepository.updateRelayerFee(
      emittedFromChainId,
      depositor,
      depositId,
      newRelayerFeePct,
      transactionHash,
      timestamp
    );
  }

  public getFilledTransfers(depositorAddr: TrackableAddress, limit?: number, offset?: number) {
    if (depositorAddr === "all") {
      return this.transfersRepository.getAllFilledTransfers();
    }
    return this.transfersRepository.getFilledTransfers(depositorAddr, limit, offset);
  }

  public getPendingTransfers(depositorAddr: TrackableAddress, limit?: number, offset?: number) {
    if (depositorAddr === "all") {
      return this.transfersRepository.getAllPendingTransfers();
    }
    return this.transfersRepository.getPendingTransfers(depositorAddr, limit, offset);
  }
}
