import { SpokePool } from "@across-protocol/contracts-v2";
import { TypedEvent, TypedEventFilter } from "@across-protocol/contracts-v2/dist/typechain/common";
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
}

/**
 * Class that wraps the queryFilter calls and has the ability to resize the block range
 * in order to comply with the eventual node restrictions in terms of the block range or the
 * length of the response
 */
export class SpokePoolEventsQuerier implements ISpokePoolContractEventsQuerier {
  constructor(private spokePool: SpokePool, private blockRangeSize?: number, private logger?: Logger) {}

  public async getFundsDepositEvents(from: number, to: number, depositorAddr?: string): Promise<TypedEvent<any>[]> {
    return this.getEvents(from, to, this.getDepositEventsFilters(depositorAddr));
  }

  public async getFilledRelayEvents(from: number, to: number, depositorAddr?: string): Promise<TypedEvent<any>[]> {
    return this.getEvents(from, to, this.getFilledRelayEventsFilter(depositorAddr));
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

  private async getEvents(
    from: number,
    to: number,
    filters: TypedEventFilter<TypedEvent<any>[], any>
  ): Promise<TypedEvent<any>[]> {
    let events: TypedEvent<any>[] = [];
    let retryWithLowerBatchSize;

    do {
      try {
        retryWithLowerBatchSize = false;
        events = [];

        if (this.blockRangeSize) {
          for (const [intervalStart, intervalEnd] of getSamplesBetween(from, to, this.blockRangeSize)) {
            const newEvents = await this.spokePool.queryFilter(filters, intervalStart, intervalEnd);
            events.push(...newEvents);
          }
        } else {
          const newEvents = await this.spokePool.queryFilter(filters, from, to);
          events.push(...newEvents);
        }
      } catch (error) {
        if ((error as Web3Error).error.code === Web3ErrorCode.BLOCK_RANGE_TOO_LARGE) {
          const newBlockRangeSize = this.blockRangeSize ? this.blockRangeSize / 2 : DEFAULT_BLOCK_RANGE;
          this.logger?.debug(
            `[SpokePoolEventsQuerier::getEventsInBatches]`,
            `🔴 lowering block range size from ${this.blockRangeSize} to ${(newBlockRangeSize as number) / 2}`
          );
          this.blockRangeSize = newBlockRangeSize;
          retryWithLowerBatchSize = true;
        } else {
          retryWithLowerBatchSize = false;
          throw error;
        }
      }
    } while (retryWithLowerBatchSize);

    return events;
  }
}
