import winston from "winston";
import { Address, Rpc, SolanaRpcApiFromTransport, RpcTransport } from "@solana/kit";

import { BigNumber, DepositSearchResult, EventSearchConfig, MakeOptional } from "../../utils";
import {
  SvmSpokeEventsClient,
  SVMEventNames,
  getFillDeadline,
  getTimestampForBlock,
  getStatePda,
} from "../../arch/svm";
import { HubPoolClient } from "../HubPoolClient";
import { knownEventNames, SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
import { RelayData, FillStatus } from "../../interfaces";

/**
 * SvmSpokePoolClient is a client for the SVM SpokePool program. It extends the base SpokePoolClient
 * and implements the abstract methods required for interacting with an SVM Spoke Pool.
 */
export class SvmSpokePoolClient extends SpokePoolClient {
  /**
   * Private constructor. Use the async create() method to instantiate.
   */
  private constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentSlot: bigint, // Using slot instead of block number for SVM
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock">,
    protected programId: string,
    protected statePda: Address,
    protected svmEventsClient: SvmSpokeEventsClient,
    protected rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>
  ) {
    // Convert deploymentSlot to number for base class, might need refinement
    super(logger, hubPoolClient, chainId, Number(deploymentSlot), eventSearchConfig);
  }

  /**
   * Factory method to asynchronously create an instance of SvmSpokePoolClient.
   */
  public static async create(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentSlot: bigint,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }, // Provide default
    programId: string,
    rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>
  ): Promise<SvmSpokePoolClient> {
    const statePda = await getStatePda(programId);
    const svmEventsClient = await SvmSpokeEventsClient.create(rpc);
    return new SvmSpokePoolClient(
      logger,
      hubPoolClient,
      chainId,
      deploymentSlot,
      eventSearchConfig,
      programId,
      statePda,
      svmEventsClient,
      rpc
    );
  }

  public _queryableEventNames(): string[] {
    // We want to take the internal event names relevant to
    // the SVM SpokePoolClient and filter them against the
    // knownEventNames list that we reference in practice
    const internalEventNames = Object.values(SVMEventNames);
    return internalEventNames.filter((e) => knownEventNames.includes(e));
  }

  /**
   * Performs an update to refresh the state of this client by querying SVM events.
   */
  protected _update(_eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    throw new Error("update not implemented for SVM");
    // const searchStartSlot = BigInt(this.firstBlockToSearch);
    // let searchEndSlot: bigint;
    // try {
    //   // Determine the end slot for the search
    //   if (this.eventSearchConfig.toBlock !== undefined) {
    //     searchEndSlot = BigInt(this.eventSearchConfig.toBlock);
    //   } else {
    //     const latestSlot = await this.rpc.getSlot({ commitment: "confirmed" }).send();
    //     // Use default 0 for maxBlockLookBack if not provided
    //     const lookBackBy = BigInt(this.eventSearchConfig.maxBlockLookBack ?? 0);
    //     const lookBackLimitSlot = lookBackBy > 0 ? latestSlot - lookBackBy : BigInt(0);
    //     const effectiveStartSlot = searchStartSlot > lookBackLimitSlot ? searchStartSlot : lookBackLimitSlot;
    //     // Ensure end slot is not before start slot
    //     searchEndSlot = latestSlot > effectiveStartSlot ? latestSlot : effectiveStartSlot;
    //     if (effectiveStartSlot > searchEndSlot) {
    //       this.log("info", `Start slot ${effectiveStartSlot} is after end slot ${searchEndSlot}, nothing to query.`);
    //       return {
    //         success: true,
    //         currentTime: this.currentTime, // No time update if no query
    //         events: [],
    //         // Report the block *before* the effective start if nothing was queried
    //         searchEndBlock: Number(effectiveStartSlot) - 1,
    //       };
    //     }
    //   }
    //   this.log("debug", `Querying SVM events from slot ${searchStartSlot} to ${searchEndSlot}`);
    //   // Query events for each requested type using the public method
    //   const allQueriedEvents: Log[] = [];
    //   for (const eventName of eventsToQuery) {
    //     // Cast string eventName to the specific EventName type
    //     const typedEventName = eventName as EventName;
    //     const events = await this.svmEventsClient.queryEvents<EventData>(
    //       typedEventName,
    //       searchStartSlot,
    //       searchEndSlot,
    //       {
    //         commitment: "confirmed",
    //       }
    //     );
    //     // Map SVM event structure to expected Log structure
    //     const mappedEvents: Log[] = events.map((event) => ({
    //       name: event.name,
    //       args: event.data as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    //       blockNumber: Number(event.slot), // Using slot as blockNumber (potential precision loss for very large slots)
    //       transactionHash: event.signature.toString(),
    //       logIndex: 0, // SVM doesn't have a direct logIndex equivalent per event in a tx? Assign 0
    //       address: event.program.toString(), // Program address
    //       blockHash: event.blockHash.toString(),
    //       transactionIndex: event.transactionIndex,
    //     }));
    //     allQueriedEvents.push(...mappedEvents);
    //   }
    //   // Group events by name
    //   const groupedEvents: { [eventName: string]: Log[] } = {};
    //   for (const event of allQueriedEvents) {
    //     groupedEvents[event.name] = groupedEvents[event.name] || [];
    //     groupedEvents[event.name].push(event);
    //   }
    //   // Sort events within each group by blockNumber (slot) (ascending)
    //   // and prepare final results array in the order requested by eventsToQuery
    //   const queryResults: Log[][] = eventsToQuery.map((eventName) => {
    //     const events = groupedEvents[eventName] || [];
    //     events.sort((a, b) => a.blockNumber - b.blockNumber);
    //     return events;
    //   });
    //   // TODO: Implement processing logic similar to the EVM version in SpokePoolClient.update
    //   // This involves taking the `queryResults` and updating internal state like
    //   // this.depositHashes, this.fills, this.speedUps, etc., based on the event data.
    //   // This current implementation only fetches the events but doesn't process them into state.
    //   // Placeholder for current time - get timestamp of the searchEndSlot
    //   // Handle case where searchEndSlot might be 0 or negative if calculation results in it.
    //   const currentTime = searchEndSlot > 0 ? await this.getTimestampForBlock(Number(searchEndSlot)) : 0;
    //   return {
    //     success: true,
    //     currentTime: currentTime,
    //     events: queryResults, // Pass the structured events
    //     searchEndBlock: Number(searchEndSlot), // Use slot number
    //   };
    // } catch (error: unknown) {
    //   this.log("error", "Failed to update SVM SpokePoolClient during event fetching or processing", {
    //     error: error instanceof Error ? error.message : String(error),
    //   });
    //   // Use correct enum casing
    //   return { success: false, reason: UpdateFailureReason.BadRequest };
    // }
  }

  /**
   * Retrieves the fill deadline buffer fetched from the State PDA.
   * @note This function assumes that fill deadline buffer is a constant value in svm environments.
   */
  public override getMaxFillDeadlineInRange(_startSlot: number, _endSlot: number): Promise<number> {
    return getFillDeadline(this.rpc, this.statePda);
  }

  /**
   * Retrieves the timestamp for a given SVM slot number.
   */
  public override getTimestampForBlock(blockNumber: number): Promise<number> {
    return getTimestampForBlock(this.rpc, blockNumber);
  }

  /**
   * Retrieves the time (timestamp) from the SVM chain state at a particular slot.
   */
  public getTimeAt(_slot: number): Promise<number> {
    throw new Error("getTimeAt not implemented for SVM");
  }

  /**
   * Finds a deposit based on its deposit ID on the SVM chain.
   * TODO: Implement SVM state query for deposit details.
   */
  public findDeposit(_depositId: BigNumber): Promise<DepositSearchResult> {
    throw new Error("findDeposit not implemented for SVM");
  }

  /**
   * Retrieves the fill status for a given relay data from the SVM chain.
   * TODO: Implement SVM state query for fill status.
   */
  public relayFillStatus(
    _relayData: RelayData,
    _slot?: number | "latest", // Use slot instead of blockTag
    _destinationChainId?: number
  ): Promise<FillStatus> {
    throw new Error("relayFillStatus not implemented for SVM");
  }

  /**
   * Retrieves the fill status for an array of given relay data.
   * @param relayData The array relay data to retrieve the fill status for.
   * @param blockTag The block at which to query the fill status.
   * @returns The fill status for each of the given relay data.
   */
  public fillStatusArray(_relayData: RelayData[], _blockTag?: number | "latest"): Promise<(FillStatus | undefined)[]> {
    throw new Error("fillStatusArray not implemented for SVM");
  }
}
