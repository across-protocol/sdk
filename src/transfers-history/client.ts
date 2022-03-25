import { ChainId } from "../constants";
import { clientConfig } from "./config";
import {
  DepositEventsQueryServiceFactory,
  IDepositEventsQueryService,
  IDepositEventsQueryServiceFactory,
} from "./services/FundsDepositedEventsQueryService";
import { TransfersAggregatorService } from "./services/TransfersAggregatorService";
import { State, TransferFilters, TransferStatus } from "./model/state";
import { Logger } from "./adapters/logger";

/**
 * The configuration object for providing the nodes connection details and specifying which
 * chain should be used as reference (the one that has the highest block time)
 */
export type TransfersHistoryClientParams = {
  chains: {
    chainId: ChainId;
    providerUrl: string;
  }[];
  refChainId: ChainId;
};

export class TransfersHistoryClient {
  constructor(
    private config: TransfersHistoryClientParams,
    private state = new State(),
    private transfersAggregatorService = new TransfersAggregatorService(state),
    private depositEventsQueryServiceFactory: IDepositEventsQueryServiceFactory = new DepositEventsQueryServiceFactory()
  ) {
    for (const chain of config.chains) {
      clientConfig.web3Providers[chain.chainId] = chain.providerUrl;
    }
  }

  public async getTransfers(filters: TransferFilters, limit = 10, offset = 0) {
    // clean state if the filters change from one call to another
    if (this.state.filters && this.state.filters !== filters) {
      this.state.clean();
    }
    this.saveFilters(filters);

    const chainsIds = this.config.chains.map(chain => chain.chainId);
    Logger.debug("[TransfersHistoryClient::getTransfers]", `start getting ${filters.status} transfers from ${chainsIds} chains`);
    const depositEventsQueryServices = chainsIds
      .filter(chainId => chainId !== this.config.refChainId)
      .reduce<[ChainId, IDepositEventsQueryService][]>((acc, chainId) => {
        return [
          ...acc,
          [chainId, this.depositEventsQueryServiceFactory.getService(this.state, chainId, this.config.refChainId, 100000)],
        ];
      }, []);
    const depositEventsRefQueryService = this.depositEventsQueryServiceFactory.getService(
      this.state,
      this.config.refChainId,
      this.config.refChainId,
      100000
    );
    // query events from the chain used as reference
    await depositEventsRefQueryService.getEvents();
    await Promise.all(depositEventsQueryServices.map(([_, service]) => service.getEvents()));

    this.transfersAggregatorService.aggregateTransfers();
    
    // continue to query events if limit + offset is not reached and we still have blocks to query
    while (
      !this.hasRequiredNumberOfTransfersInState(filters.status, limit, offset) &&
      this.hasBlocksToQuery(chainsIds)
    ) {
      await depositEventsRefQueryService.getEvents(this.state.progress[this.config.refChainId].latestFromBlock);
      await Promise.all(depositEventsQueryServices.map(([chainId, service]) => service.getEvents(this.state.progress[chainId].latestFromBlock)));
      this.transfersAggregatorService.aggregateTransfers();
    }

    return filters.status === "filled" ? 
      this.state.completedTransfers.slice(offset, offset + limit) : 
      this.state.pendingTransfers.slice(offset, offset + limit);
  }

  private hasBlocksToQuery(chainIds: number[]) {
    for (const chainId of chainIds) {
      const latestFromBlock = this.state.progress[chainId].latestFromBlock;
      if (latestFromBlock && latestFromBlock > this.state.blockLowerBound[chainId]) {
        return true;
      }
    }
    Logger.debug("[TransfersHistoryClient::hasBlocksToQuery]", `🟡 no more blocks to query`);
    return false;
  }

  private hasRequiredNumberOfTransfersInState(status: TransferStatus, limit: number, offset: number) {
    return status === "filled"
      ? offset + limit <= this.state.completedTransfers.length
      : offset + limit <= this.state.pendingTransfers.length;
  }

  /**
   * Save filters into the state
   */
  private saveFilters(filters: TransferFilters) {
    if (this.state.filters !== filters) {
      this.state.filters = filters;
    }
  }
}
