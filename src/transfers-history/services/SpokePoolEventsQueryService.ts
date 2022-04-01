import { TypedEvent } from "@across-protocol/contracts-v2/dist/typechain/common";
import { FundsDepositedEvent, FilledRelayEvent } from "@across-protocol/contracts-v2/dist/typechain/SpokePool";
import { BigNumber, providers } from "ethers";

import { TransfersRepository } from "../adapters/db/transfers-repository";
import { Logger } from "../adapters/logger";
import { ISpokePoolContractEventsQuerier } from "../adapters/web3";
import { ChainId } from "../adapters/web3/model";
import { clientConfig } from "../config";
import { Transfer } from "../model";

export class SpokePoolEventsQueryService {
  private latestBlockNumber: number | undefined;

  constructor(
    private chainId: ChainId,
    private provider: providers.Provider,
    private eventsQuerier: ISpokePoolContractEventsQuerier,
    private logger: Logger,
    private transfersRepository: TransfersRepository,
    private depositorAddr?: string
  ) {}

  public async getEvents() {
    const from = this.latestBlockNumber
      ? this.latestBlockNumber + 1
      : clientConfig.spokePools[this.chainId].lowerBoundBlockNumber;
    const to = (await this.provider.getBlock("latest")).number;

    if (from > to) {
      this.logger.debug(
        "[SpokePoolEventsQueryService::getEvents]",
        `🔴 chain ${this.chainId}: from ${from} > to ${to}`
      );
      return;
    }

    this.logger.debug(
      "[SpokePoolEventsQueryService::getEvents]",
      `🟢 chain ${this.chainId}: fetched events from ${from} to ${to}`
    );
    const depositEvents = await this.eventsQuerier.getFundsDepositEvents(from, to, this.depositorAddr);
    const filledRelayEvents = await this.eventsQuerier.getFilledRelayEvents(from, to, this.depositorAddr);
    this.logger.debug(
      "[SpokePoolEventsQueryService::getEvents]",
      `🟢 chain ${this.chainId}: fetched ${depositEvents.length} FundsDeposited events and ${filledRelayEvents.length} FilledRelayEvents`
    );
    const blockTimestampMap = await this.getBlocksTimestamp([...depositEvents, ...filledRelayEvents]);
    depositEvents.map(event => this.insertFundsDepositedEvent(event, blockTimestampMap[event.blockNumber]));
    filledRelayEvents.map(event => this.insertFilledRelayEvent(event));
    this.latestBlockNumber = to;
  }

  private insertFundsDepositedEvent(event: FundsDepositedEvent, timestamp: number) {
    const { args, transactionHash } = event;
    const { amount, originToken, destinationChainId, depositId, depositor } = args;
    const transfer: Transfer = {
      amount: BigNumber.from(amount),
      assetAddr: originToken,
      depositId: depositId,
      depositTime: timestamp,
      depositTxHash: transactionHash,
      destinationChainId: destinationChainId.toNumber(),
      filled: BigNumber.from("0"),
      sourceChainId: this.chainId,
      status: "pending",
    };
    this.transfersRepository.insertTransfer(this.chainId, depositor, depositId, transfer);
  }

  private insertFilledRelayEvent(event: FilledRelayEvent) {
    const { args } = event;
    const { totalFilledAmount, depositor, depositId } = args;
    this.transfersRepository.updateFilledAmount(this.chainId, depositor, depositId, totalFilledAmount);
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
