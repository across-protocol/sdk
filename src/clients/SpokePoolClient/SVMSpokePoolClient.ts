import { Rpc, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import winston from "winston";
import { SVMEventNames, SvmSpokeEventsClient } from "../../arch/svm";
import { FillStatus, RelayData, SortableEvent } from "../../interfaces";
import {
  BigNumber,
  DepositSearchResult,
  EventSearchConfig,
  MakeOptional,
  sortEventsAscendingInPlace,
  toBN,
} from "../../utils";
import { isUpdateFailureReason } from "../BaseAbstractClient";
import { HubPoolClient } from "../HubPoolClient";
import { knownEventNames, SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";

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
    rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>
  ): Promise<SvmSpokePoolClient> {
    const svmEventsClient = await SvmSpokeEventsClient.create(rpc);
    return new SvmSpokePoolClient(
      logger,
      hubPoolClient,
      chainId,
      deploymentSlot,
      eventSearchConfig,
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
  protected async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    const searchConfig = await this.updateSearchConfig(this.rpc);
    if (isUpdateFailureReason(searchConfig)) {
      const reason = searchConfig;
      return { success: false, reason };
    }

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!this._queryableEventNames().includes(eventName)) {
        throw new Error(`SpokePoolClient: Cannot query unrecognised SpokePool event name: ${eventName}`);
      }

      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `eventSearchConfig` passed in during instantiation.
      // However, certain events have special overriding requirements to their search ranges:
      // - EnabledDepositRoute: The full history is always required, so override the requested fromBlock.
      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.fromBlock = this.deploymentBlock;
      }

      return _searchConfig as EventSearchConfig;
    });

    const spokePoolAddress = this.svmEventsClient.getSvmSpokeAddress();

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: spokePoolAddress,
    });

    const timerStart = Date.now();

    const [currentTime, ...eventsQueried] = await Promise.all([
      this.rpc.getBlockTime(BigInt(searchConfig.toBlock)).send(),
      ...eventsToQuery.map(async (eventName, idx) => {
        const config = eventSearchConfigs[idx];
        const events = await this.svmEventsClient.queryEvents(
          eventName as SVMEventNames,
          BigInt(config.fromBlock),
          BigInt(config.toBlock)
        );
        return Promise.all(
          events.map(async (event): Promise<SortableEvent> => {
            const block = await this.rpc.getBlock(event.slot).send();

            if (!block) {
              this.log("error", `SpokePoolClient::update: Failed to get block for slot ${event.slot}`);
              throw new Error(`SpokePoolClient::update: Failed to get block for slot ${event.slot}`);
            }

            return {
              transactionHash: event.signature.toString(),
              blockNumber: Number(block.blockHeight),
              transactionIndex: 0,
              logIndex: 0,
              // transactionIndex: eve
              // ...event.data,
            };
          })
        );
      }),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);
    if (!BigNumber.isBigNumber(currentTime) || currentTime.lt(this.currentTime)) {
      const errMsg = BigNumber.isBigNumber(currentTime)
        ? `currentTime: ${currentTime} < ${toBN(this.currentTime)}`
        : `currentTime is not a BigNumber: ${JSON.stringify(currentTime)}`;
      throw new Error(`SpokePoolClient::update: ${errMsg}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    eventsQueried.forEach((events) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: currentTime.toNumber(), // uint32
      searchEndBlock: searchConfig.toBlock,
      events: eventsQueried,
    };
  }

  /**
   * Retrieves the maximum fill deadline buffer.
   * TODO: Implement SVM equivalent, perhaps reading from a config account.
   */
  public getMaxFillDeadlineInRange(_startSlot: number, _endSlot: number): Promise<number> {
    throw new Error("getMaxFillDeadlineInRange not implemented for SVM");
  }

  /**
   * Retrieves the timestamp for a given SVM slot number.
   */
  public getTimestampForBlock(_blockNumber: number): Promise<number> {
    throw new Error("getTimestampForBlock not implemented for SVM");
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
