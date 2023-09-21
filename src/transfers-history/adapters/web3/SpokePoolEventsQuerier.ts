/* eslint-disable @typescript-eslint/no-explicit-any */
import { SpokePool, TypedEvent, TypedEventFilter } from "../../../typechain";
import { getSamplesBetween } from "../../../utils";
import { Web3Error, Web3ErrorCode } from "./model";
import { Logger } from "../logger";

const DEFAULT_BLOCK_RANGE = 100_000;

/**
 * Interface implemented by classes that fetch contract events from the SpokePool contracts
 */
export interface ISpokePoolContractEventsQuerier {
  getFundsDepositEvents: (from: number, to: number, depositorAddr?: string) => Promise<TypedEvent<any>[]>;
  getFilledRelayEvents: (from: number, to: number, depositorAddr?: string) => Promise<TypedEvent<any>[]>;
  getSpeedUpDepositEvents: (from: number, to: number, depositorAddr?: string) => Promise<TypedEvent<any>[]>;
}

/**
 * Class that wraps the queryFilter calls and has the ability to resize the block range
 * in order to comply with the eventual node restrictions in terms of the block range or the
 * length of the response
 */
export class SpokePoolEventsQuerier implements ISpokePoolContractEventsQuerier {
  constructor(
    private spokePool: SpokePool,
    private blockRangeSize?: number,
    private logger?: Logger
  ) {}

  public async getFundsDepositEvents(from: number, to: number, depositorAddr?: string): Promise<TypedEvent<any>[]> {
    return this.getEvents(from, to, this.getDepositEventsFilters(depositorAddr));
  }

  public async getFilledRelayEvents(from: number, to: number, depositorAddr?: string): Promise<TypedEvent<any>[]> {
    return this.getEvents(from, to, this.getFilledRelayEventsFilter(depositorAddr));
  }

  public async getSpeedUpDepositEvents(from: number, to: number, depositorAddr?: string): Promise<TypedEvent<any>[]> {
    return this.getEvents(from, to, this.getSpeedUpDepositEventsFilter(depositorAddr));
  }

  private getFilledRelayEventsFilter(depositorAddr?: string) {
    if (depositorAddr) {
      return this.spokePool.filters.FilledRelay(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        depositorAddr,
        undefined,
        undefined,
        undefined
      );
    }
    return this.spokePool.filters.FilledRelay();
  }

  private getDepositEventsFilters(depositorAddr?: string) {
    if (depositorAddr) {
      return this.spokePool.filters.FundsDeposited(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        depositorAddr.toLowerCase()
      );
    }
    return this.spokePool.filters.FundsDeposited();
  }

  private getSpeedUpDepositEventsFilter(depositorAddr?: string) {
    if (depositorAddr) {
      return this.spokePool.filters.RequestedSpeedUpDeposit(
        undefined,
        undefined,
        depositorAddr.toLowerCase(),
        undefined
      );
    }
    return this.spokePool.filters.RequestedSpeedUpDeposit();
  }

  private async getEvents(from: number, to: number, filters: TypedEventFilter<TypedEvent>): Promise<TypedEvent<any>[]> {
    let events: TypedEvent<any>[] = [];
    let retryWithLowerBatchSize;

    do {
      const blockRangeSizeAtStart = this.blockRangeSize;
      try {
        retryWithLowerBatchSize = false;
        events = [];

        if (this.blockRangeSize) {
          const intervals = getSamplesBetween(from, to, this.blockRangeSize);
          // query events only for the first interval to make sure block range is fine
          const [intervalStart, intervalEnd] = intervals[0];
          const newEvents = await this.spokePool.queryFilter(filters, intervalStart, intervalEnd);
          events.push(...newEvents);

          // query the rest of block intervals in parallel in order to get the events
          const newEventsList = await Promise.all(
            intervals
              .slice(1)
              .map(([intervalStart, intervalEnd]) => this.spokePool.queryFilter(filters, intervalStart, intervalEnd))
          );
          events.push(...newEventsList.flat());
        } else {
          const newEvents = await this.spokePool.queryFilter(filters, from, to);
          events.push(...newEvents);
        }
      } catch (error) {
        if (
          (error as Web3Error).error.code === Web3ErrorCode.BLOCK_RANGE_TOO_LARGE ||
          (error as Web3Error).error.code === Web3ErrorCode.EXCEEDED_MAXIMUM_BLOCK_RANGE
        ) {
          // make sure the block range size wasn't modified by a parallel function call
          if (this.blockRangeSize === blockRangeSizeAtStart) {
            const newBlockRangeSize = this.blockRangeSize ? this.blockRangeSize / 2 : DEFAULT_BLOCK_RANGE;
            this.logger?.debug(
              "[SpokePoolEventsQuerier::getEventsInBatches]",
              `🔴 lowering block range size from ${this.blockRangeSize} to ${newBlockRangeSize}`
            );
            this.blockRangeSize = newBlockRangeSize;
          }
          retryWithLowerBatchSize = true;
        } else {
          retryWithLowerBatchSize = false;
          console.error(error);
          throw error;
        }
      }
    } while (retryWithLowerBatchSize);

    return events;
  }
}
