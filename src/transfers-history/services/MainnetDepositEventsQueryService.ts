import { SpokePool__factory } from "@across-protocol/contracts-v2";
import { FundsDepositedEvent } from "@across-protocol/contracts-v2/dist/typechain/SpokePool";
import { BigNumber, providers } from "ethers";
import { ChainId, SPOKE_POOLS } from "../../constants";
import { Logger } from "../adapters/logger";
import { ISpokePoolContractEventsQuerier, SpokePoolEventsQuerier } from "../adapters/web3";
import { clientConfig } from "../config";
import { State, Transfer } from "../model/state";

export interface IDepositEventsQueryServiceFactory {
  getService(
    state: State,
    chainId: ChainId,
    refChainId: ChainId,
    blockRangeSize?: number,
    depositorAddr?: string
  ): IDepositEventsQueryService;
}

export class DepositEventsQueryServiceFactory implements IDepositEventsQueryServiceFactory {
  getService(state: State, chainId: ChainId, refChainId: ChainId, blockRangeSize?: number, depositorAddr?: string) {
    const provider = new providers.JsonRpcProvider(clientConfig.web3Providers[chainId]);
    const spokePool = SpokePool__factory.connect(SPOKE_POOLS[chainId], provider);
    const eventsQuerier = new SpokePoolEventsQuerier(spokePool, blockRangeSize);
    return new DepositEventsQueryService(
      chainId,
      state,
      provider,
      eventsQuerier,
      refChainId,
      blockRangeSize,
      depositorAddr
    );
  }
}

type GetEventsResult = {
  fromBlock: number;
  toBlock: number;
  numberOfEvents: number;
};

/**
 * Interface implemented by the classes that are used to:
 * 1. query FundsDepositedEvent events
 * 2. handle Web3 provider errors
 * 3. save the events in the client state
 */
export interface IDepositEventsQueryService {
  getEvents(toBlock?: number): Promise<GetEventsResult>;
}

export class DepositEventsQueryService implements IDepositEventsQueryService {
  constructor(
    private chainId: ChainId,
    private state: State,
    private provider: providers.Provider,
    private eventsQuerier: ISpokePoolContractEventsQuerier,
    private refChainId: ChainId,
    private blockRangeSize?: number,
    private depositorAddr?: string
  ) {}

  public async getEvents(toBlock?: number): Promise<GetEventsResult> {
    const isRefChain = this.chainId === this.refChainId;

    if (!isRefChain) {
      let continueQueryEvents;
      let fromBlock = 0;
      let toBlock = 0;
      let numberOfEvents = 0;

      do {
        continueQueryEvents = false;
        const result = await this._getEvents(isRefChain, toBlock);
        fromBlock = Math.min(fromBlock, result.fromBlock);
        toBlock = Math.max(toBlock, result.toBlock);
        numberOfEvents += result.numberOfEvents;

        const latestRefTimestamp = this.state.progress[this.refChainId].latestFromTimestamp;
        const latestTimestamp = this.state.progress[this.chainId].latestFromTimestamp;
        if (latestRefTimestamp && latestTimestamp && latestRefTimestamp < latestTimestamp) {
          continueQueryEvents = true;
        }
      } while (continueQueryEvents);

      return { fromBlock, toBlock, numberOfEvents };
    } else {
      return this._getEvents(isRefChain, toBlock);
    }
  }

  private async _getEvents(isRefChain: boolean, toBlock?: number) {
    const to = toBlock || (await this.provider.getBlock("latest")).number;
    // if blockRangeSize is passed make sure it isn't lower than the minimim accepted block
    const from =
      typeof this.blockRangeSize === "number"
        ? Math.max(to - this.blockRangeSize + 1, this.state.blockLowerBound[this.chainId])
        : this.state.blockLowerBound[this.chainId];

    if (from === this.state.progress[this.chainId]?.latestFromBlock) {
      Logger.debug("[TransfersHistoryClient::hasBlocksToQuery]", `🟡 no more blocks to query for chain ${this}`);
      return { fromBlock: from, toBlock: to, numberOfEvents: 0 };
    }

    Logger.debug(
      "[DepositEventsQueryService::getEvents]",
      `⌛ ${isRefChain && "ref "}chain ${this.chainId} fetching events from blocks ${from} -> ${to}`
    );
    const { events } = await this.eventsQuerier.getDepositEvents(from, to, this.depositorAddr);
    Logger.debug(
      "[DepositEventsQueryService::getEvents]",
      `✅ ${isRefChain && "ref "}chain ${this.chainId} fetched ${events.length} events`
    );

    this.state.setLatestFromBlock(this.chainId, from);
    this.state.setLatestToBlock(this.chainId, to);

    if (events.length > 0) {
      const blockTimestampMap = await this.getBlockTimestamps(events);
      await Promise.all(events.map(event => this.insertEvent(event, blockTimestampMap[event.blockNumber])));
      this.state.setLatestFromTimestamp(this.chainId, blockTimestampMap[events[0].blockNumber]);
    }

    Logger.debug(
      "[DepositEventsQueryService::getEvents]",
      `🟢 updated progress for ${this.chainId}: ${JSON.stringify(this.state.progress[this.chainId])}`
    );
    return { fromBlock: from, toBlock: to, numberOfEvents: events.length };
  }

  private insertEvent(event: FundsDepositedEvent, timestamp: number) {
    const { args, transactionHash } = event;
    const { amount, originToken, destinationChainId, depositId } = args;
    const transfer: Transfer = {
      amount,
      assetAddr: originToken,
      depositId: depositId,
      depositTime: timestamp,
      depositTxHash: transactionHash,
      destinationChainId: destinationChainId.toNumber(),
      filled: BigNumber.from("0"),
      sourceChainId: ChainId.ARBITRUM_RINKEBY,
      status: "pending",
    };
    this.state.insertTransfer(ChainId.ARBITRUM_RINKEBY, depositId, transfer);
  }

  private async getBlockTimestamps(events: FundsDepositedEvent[]) {
    const uniqueBlockNumbers = events.reduce((acc, event) => {
      return { ...acc, [event.blockNumber]: true };
    }, {} as Record<number, any>);
    const uniqueBlockNumbersList = Object.keys(uniqueBlockNumbers).map(blockNumber => parseInt(blockNumber));
    Logger.debug(
      "[DepositEventsQueryService::getBlockTimestamps]",
      `🟢 identified ${uniqueBlockNumbersList.length} unique blocks from events`
    );
    const blocks = await Promise.all(uniqueBlockNumbersList.map(blockNumber => this.provider.getBlock(blockNumber)));
    const timestamps = await Promise.all(blocks.map(block => block.timestamp));
    Logger.debug(
      "[DepositEventsQueryService::getBlockTimestamps]",
      `🟢 got ${timestamps.length} timestamps for the unique blocks`
    );
    const blockTimestampMap = uniqueBlockNumbersList.reduce(
      (acc, blockNumber, idx) => ({
        ...acc,
        [blockNumber]: timestamps[idx],
      }),
      {} as Record<string, number>
    );
    return blockTimestampMap;
  }
}

