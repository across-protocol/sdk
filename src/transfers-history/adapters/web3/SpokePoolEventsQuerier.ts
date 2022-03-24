import { SpokePool } from "@across-protocol/contracts-v2";
import { TypedEvent, TypedEventFilter } from "@across-protocol/contracts-v2/dist/typechain/common";
import { getSamplesBetween } from "../../../utils";
import { Web3Error, Web3ErrorCode } from "./model";
import { Logger } from "../logger";

/**
 * Interface implemented by classes that fetch contract events from the SpokePool contracts
 */
export interface ISpokePoolContractEventsQuerier {
  getDepositEvents: (from: number, to: number, depositorAddr?: string) => Promise<EventsQueryResult>;
}

type EventsQueryResult = {
  events: TypedEvent<any>[];
};
/**
 * Class that wraps the queryFilter calls and has the ability to resize the block range
 * in order to comply with the eventual node restriction
 */
export class SpokePoolEventsQuerier implements ISpokePoolContractEventsQuerier {
  constructor(private spokePool: SpokePool, private blockRangeSize?: number) {}

  public async getDepositEvents(from: number, to: number, depositorAddr?: string): Promise<EventsQueryResult> {
    let result: EventsQueryResult;

    if (!this.blockRangeSize) {
      const events = await this.spokePool.queryFilter(this.getDepositEventsFilters(depositorAddr), from, to);
      result = {
        events,
      };
    } else {
      result = await this.getEventsInBatches(from, to, this.getDepositEventsFilters(depositorAddr));
    }

    return result;
  }

  public async getFilledRelayEvents(from: number, to: number, depositorAddr?: string): Promise<EventsQueryResult> {
    let result: EventsQueryResult;

    if (!this.blockRangeSize) {
      const events = await this.spokePool.queryFilter(this.getFilledRelayEventsFilters(depositorAddr), from, to);
      result = {
        events,
      };
    } else {
      result = await this.getEventsInBatches(from, to, this.getFilledRelayEventsFilters(depositorAddr));
    }

    return result;
  }

  private getFilledRelayEventsFilters(depositorAddr?: string) {
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
        depositorAddr
      );
    }
    return this.spokePool.filters.FundsDeposited();
  }

  private async getEventsInBatches(
    from: number,
    to: number,
    filters: TypedEventFilter<TypedEvent<any>[], any>
  ): Promise<EventsQueryResult> {
    let events: TypedEvent<any>[] = [];
    let retryWithLowerBatchSize = false;

    do {
      try {
        retryWithLowerBatchSize = false;
        const intervals = getSamplesBetween(from, to, this.blockRangeSize as number);
        for (const [from, to] of intervals) {
          const newEvents = await this.spokePool.queryFilter(filters, from, to);
          events.push(...newEvents);
        }
      } catch (error) {
        if ((error as Web3Error).error.code === Web3ErrorCode.BLOCK_RANGE_TOO_LARGE) {
          events = [];
          Logger.debug(
            `[SpokePoolEventsQuerier::getEventsInBatches]`,
            `🔴 lowering block range size from ${this.blockRangeSize} to ${(this.blockRangeSize as number) / 2}`
          );
          this.blockRangeSize = (this.blockRangeSize as number) / 2;
          retryWithLowerBatchSize = true;
        } else {
          retryWithLowerBatchSize = false;
          throw error;
        }
      }
    } while (retryWithLowerBatchSize);

    return {
      events,
    };
  }
}

// export class SpokePoolEventsQuerierTest implements IContractEventsQuerier {
//   constructor(private spokePool: SpokePool, private filters?: TypedEventFilter<TypedEvent<any>[], any>) {}

//   public async getEvents(from: number, to: number, batchSize?: number) {
//     if (!batchSize) {
//       const events = await this.spokePool.queryFilter(this.filters || {}, from, to);
//       return events;
//     } else {
//       const events: FundsDepositedEvent[] = [];
//       const intervals = getSamplesBetween(from, to, batchSize);
//       for (const [from, to] of intervals) {
//         events.push(...(await this.spokePool.queryFilter(this.filters || {}, from, to)));
//       }
//     }
//   }
// }
