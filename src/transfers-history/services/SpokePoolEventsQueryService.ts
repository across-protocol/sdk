import { TypedEvent } from "@across-protocol/contracts-v2/dist/typechain/common";
import { FundsDepositedEvent, FilledRelayEvent } from "@across-protocol/contracts-v2/dist/typechain/SpokePool";
import { providers } from "ethers";
import { Logger } from "../adapters/logger";
import { ISpokePoolContractEventsQuerier } from "../adapters/web3";
import { ChainId } from "../adapters/web3/model";
import { clientConfig } from "../config";

export class SpokePoolEventsQueryService {
  private latestBlockNumber: number | undefined;

  constructor(
    private chainId: ChainId,
    private provider: providers.Provider,
    private eventsQuerier: ISpokePoolContractEventsQuerier,
    private logger: Logger,
    private depositorAddr?: string
  ) {}

  public async getEvents() {
    let from;
    let depositEvents: FundsDepositedEvent[] = [];
    let filledRelayEvents: FilledRelayEvent[] = [];
    let blockTimestampMap: { [blockNumber: number]: number } = {};

    if (this.latestBlockNumber) {
      from = this.latestBlockNumber + 1;
    } else {
      from = clientConfig.spokePools[this.chainId].lowerBoundBlockNumber ?? -1;
    }
    const to = (await this.provider.getBlock("latest")).number;

    if (from > to) {
      this.logger.debug("[SpokePoolEventsQueryService]", `🔴 chain ${this.chainId}: from ${from} > to ${to}`);

      return {
        depositEvents: [],
        filledRelayEvents: [],
        blockTimestampMap: {},
      };
    }

    [depositEvents, filledRelayEvents] = await Promise.all([
      this.eventsQuerier.getFundsDepositEvents(from, to, this.depositorAddr),
      this.eventsQuerier.getFilledRelayEvents(from, to, this.depositorAddr),
    ]);

    console.log(filledRelayEvents.filter(f => f.args.depositId === 9));
    this.logger.debug(
      "[SpokePoolEventsQueryService::getEvents]",
      `🟢 chain ${this.chainId}: fetched ${depositEvents.length} FundsDeposited events and ${filledRelayEvents.length} FilledRelayEvents from block ${from} to block ${to}`
    );
    blockTimestampMap = await this.getBlocksTimestamp(depositEvents);
    this.latestBlockNumber = to;

    return {
      depositEvents,
      filledRelayEvents,
      blockTimestampMap,
    };
  }

  /**
   * Take and array of contract events and return the timestamp of the blocks as a dictionary
   * @param events
   */
  private async getBlocksTimestamp(events: TypedEvent<any>[]) {
    const uniqueBlockNumbers = events.reduce((acc, event) => {
      return { ...acc, [event.blockNumber]: true };
    }, {} as Record<number, any>);
    const uniqueBlockNumbersList = Object.keys(uniqueBlockNumbers).map(blockNumber => parseInt(blockNumber));
    const blocks = await Promise.all(uniqueBlockNumbersList.map(blockNumber => this.provider.getBlock(blockNumber)));
    const timestamps = await Promise.all(blocks.map(block => block.timestamp));
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
