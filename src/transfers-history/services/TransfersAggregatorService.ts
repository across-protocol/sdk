import { ChainId } from "../../constants";
import { Logger } from "../adapters/logger";
import { State, Transfer } from "../model/state";

export class TransfersAggregatorService {
  constructor(private state: State) {}

  public aggregateTransfers() {
    // get fromTimestamps of the fetched events
    const fromTimestamps = Object.values(this.state.progress)
      .filter(progress => typeof progress?.latestFromTimestamp === "number")
      .map(progress => progress.latestFromTimestamp as number);

    if (fromTimestamps.length === 0) {
      // We didn't fetch any events from chain yet
      Logger.debug(`[TransfersAggregatorService::aggregateTransfers]`, `🟠 no events in the state to aggregate`);
      return;
    }

    // get the highest fromTimestamp from the fetched events
    const highestFromTimestamp = Math.max(...fromTimestamps);
    // console.log(this.state.chainTransfers);
    const chainIds = Object.keys(this.state.chainTransfers).map(chainId => parseInt(chainId)) as ChainId[];
    // construct a matrix of [depositId, transfer] tuples where the rows corespond to each chain
    const depositIdTransferTuplesMatrix = chainIds.map(chainId => {
      return Object.entries(this.state.chainTransfers[chainId]);
    });
    // filter the events that are more recent than the highest fromTimestamp
    const transfers = depositIdTransferTuplesMatrix.reduce<Transfer[]>((acc, depositIdTransferTuples) => {
      return [
        ...acc,
        ...depositIdTransferTuples
          .filter(([_, transfer]) => transfer.depositTime >= highestFromTimestamp)
          .map(([_, transfer]) => transfer),
      ];
    }, []);
    Logger.debug(
      `[TransfersAggregatorService::aggregateTransfers]`,
      `🟢 found ${transfers.length} with timestamp >= ${highestFromTimestamp}`
    );
    // filter events by status
    const filteredTransfers = transfers.reduce(
      (acc, transfer) => ({
        pending: transfer.status === "pending" ? [...acc.pending, transfer] : acc.pending,
        filled: transfer.status === "filled" ? [...acc.filled, transfer] : acc.filled,
      }),
      { pending: [] as Transfer[], filled: [] as Transfer[] }
    );

    this.state.completedTransfers = filteredTransfers.filled;
    this.state.pendingTransfers = filteredTransfers.pending;

    Logger.debug(
      `[TransfersAggregatorService::aggregateTransfers]`,
      `🟢 completed transfers: ${filteredTransfers.filled.length}, pending transfers: ${filteredTransfers.pending.length}`
    );
  }
}
