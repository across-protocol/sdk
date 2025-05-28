import { Address, Rpc, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import winston from "winston";
import {
  SVMEventNames,
  unwrapEventData,
  getFillDeadline,
  getTimestampForSlot,
  getStatePda,
  SvmCpiEventsClient,
  findDeposit,
  relayFillStatus,
  fillStatusArray,
} from "../../arch/svm";
import { FillStatus, RelayData, SortableEvent } from "../../interfaces";
import {
  BigNumber,
  DepositSearchResult,
  EventSearchConfig,
  InvalidFill,
  isZeroAddress,
  MakeOptional,
  sortEventsAscendingInPlace,
  SvmAddress,
} from "../../utils";
import { isUpdateFailureReason } from "../BaseAbstractClient";
import { HubPoolClient } from "../HubPoolClient";
import { knownEventNames, SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";

/**
 * SvmSpokePoolClient is a client for the SVM SpokePool program. It extends the base SpokePoolClient
 * and implements the abstract methods required for interacting with an SVM Spoke Pool.
 */
export class SVMSpokePoolClient extends SpokePoolClient {
  /**
   * Note: Strongly prefer to use the async create() method to instantiate.
   */
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentSlot: bigint, // Using slot instead of block number for SVM
    eventSearchConfig: MakeOptional<EventSearchConfig, "to">,
    public svmEventsClient: SvmCpiEventsClient,
    protected programId: Address,
    protected statePda: Address
  ) {
    // Convert deploymentSlot to number for base class, might need refinement
    super(logger, hubPoolClient, chainId, Number(deploymentSlot), eventSearchConfig);
    this.spokePoolAddress = SvmAddress.from(programId.toString());
  }

  /**
   * Factory method to asynchronously create an instance of SvmSpokePoolClient.
   */
  public static async create(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentSlot: bigint,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 }, // Provide default
    rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>
  ): Promise<SVMSpokePoolClient> {
    const svmEventsClient = await SvmCpiEventsClient.create(rpc);
    const programId = svmEventsClient.getProgramAddress();
    const statePda = await getStatePda(programId);
    return new SVMSpokePoolClient(
      logger,
      hubPoolClient,
      chainId,
      deploymentSlot,
      eventSearchConfig,
      svmEventsClient,
      programId,
      statePda
    );
  }

  /**
   * Factory method to asynchronously create an instance of SvmSpokePoolClient with an existing event client.
   */
  public static async createWithExistingEventClient(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | null,
    chainId: number,
    deploymentSlot: bigint,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 }, // Provide default
    eventClient: SvmCpiEventsClient
  ) {
    const programId = eventClient.getProgramAddress();
    const statePda = await getStatePda(programId);
    return new SVMSpokePoolClient(
      logger,
      hubPoolClient,
      chainId,
      deploymentSlot,
      eventSearchConfig,
      eventClient,
      programId,
      statePda
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
    const searchConfig = await this.updateSearchConfig(this.svmEventsClient.getRpc());
    if (isUpdateFailureReason(searchConfig)) {
      const reason = searchConfig;
      return { success: false, reason };
    }

    const deploymentSlot = BigInt(this.deploymentBlock);

    const eventSearchConfigs = eventsToQuery.map((eventName) => {
      if (!this._queryableEventNames().includes(eventName)) {
        throw new Error(`SpokePoolClient: Cannot query unrecognised SpokePool event name: ${eventName}`);
      }

      const _searchConfig = { ...searchConfig }; // shallow copy

      // By default, an event's query range is controlled by the `eventSearchConfig` passed in during instantiation.
      // However, certain events have special overriding requirements to their search ranges:
      // - EnabledDepositRoute: The full history is always required, so override the requested fromBlock.
      if (eventName === "EnabledDepositRoute" && !this.isUpdated) {
        _searchConfig.from = Number(deploymentSlot);
      }

      return _searchConfig as EventSearchConfig;
    });

    const spokePoolAddress = this.svmEventsClient.getProgramAddress();

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      eventsToQuery,
      searchConfig,
      spokePool: spokePoolAddress,
    });

    const timerStart = Date.now();

    const [currentTime, ...eventsQueried] = await Promise.all([
      this.svmEventsClient.getRpc().getBlockTime(BigInt(searchConfig.to)).send(),
      ...eventsToQuery.map(async (eventName, idx) => {
        const config = eventSearchConfigs[idx];
        const events = await this.svmEventsClient.queryEvents(
          eventName as SVMEventNames,
          BigInt(config.from),
          BigInt(config.to),
          {
            limit: config.maxLookBack,
          }
        );
        return events.map(
          (event): SortableEvent => ({
            txnRef: event.signature,
            blockNumber: Number(event.slot),
            txnIndex: 0,
            logIndex: 0,
            ...(unwrapEventData(event.data) as Record<string, unknown>),
          })
        );
      }),
    ]);
    this.log("debug", `Time to query new events from RPC for ${this.chainId}: ${Date.now() - timerStart} ms`);
    if (currentTime < this.currentTime) {
      const errMsg = `currentTime: ${currentTime} < ${this.currentTime}`;
      throw new Error(`SvmSpokePoolClient::update: ${errMsg}`);
    }

    // Sort all events to ensure they are stored in a consistent order.
    eventsQueried.forEach((events) => sortEventsAscendingInPlace(events));

    return {
      success: true,
      currentTime: Number(currentTime), // uint32
      searchEndBlock: searchConfig.to,
      events: eventsQueried,
    };
  }

  /**
   * Retrieves the fill deadline buffer fetched from the State PDA.
   * @note This function assumes that fill deadline buffer is a constant value in svm environments.
   */
  public override getMaxFillDeadlineInRange(_startSlot: number, _endSlot: number): Promise<number> {
    return getFillDeadline(this.svmEventsClient.getRpc(), this.statePda);
  }

  /**
   * Retrieves the timestamp for a given SVM slot number.
   */
  public override getTimestampForBlock(slot: number): Promise<number> {
    return getTimestampForSlot(this.svmEventsClient.getRpc(), slot);
  }

  /**
   * Retrieves the timestamp for a given SVM slot number.
   * @note This function uses the same underlying function as getTimestampForBlock.
   *       It is kept for consistency with the EVM SpokePoolClient.
   */
  public getTimeAt(slot: number): Promise<number> {
    return getTimestampForSlot(this.svmEventsClient.getRpc(), slot);
  }

  /**
   * Finds a deposit based on its deposit ID on the SVM chain.
   */
  public async findDeposit(depositId: BigNumber): Promise<DepositSearchResult> {
    const deposit = await findDeposit(this.svmEventsClient, depositId);
    if (!deposit) {
      return {
        found: false,
        code: InvalidFill.DepositIdNotFound,
        reason: `Deposit with ID ${depositId} not found`,
      };
    }
    // Because we have additional context about this deposit, we can enrich it
    // with additional information.
    return {
      found: true,
      deposit: {
        ...deposit,
        quoteBlockNumber: await this.getBlockNumber(Number(deposit.quoteTimestamp)),
        originChainId: this.chainId,
        fromLiteChain: this.isOriginLiteChain(deposit),
        toLiteChain: this.isDestinationLiteChain(deposit),
        outputToken: isZeroAddress(deposit.outputToken)
          ? this.getDestinationTokenForDeposit(deposit)
          : deposit.outputToken,
      },
    };
  }

  /**
   * Retrieves the fill status for a given relay data from the SVM chain.
   */
  public override relayFillStatus(
    relayData: RelayData,
    atHeight?: number,
    destinationChainId?: number
  ): Promise<FillStatus> {
    destinationChainId ??= this.chainId;
    return relayFillStatus(this.programId, relayData, destinationChainId, this.svmEventsClient, atHeight);
  }

  /**
   * Retrieves the fill status for an array of given relay data.
   * @param relayData The array relay data to retrieve the fill status for.
   * @param atHeight The slot at which to query the fill status.
   * @returns The fill status for each of the given relay data.
   */
  public fillStatusArray(
    relayData: RelayData[],
    atHeight?: number,
    destinationChainId?: number
  ): Promise<(FillStatus | undefined)[]> {
    // @note: deploymentBlock actually refers to the deployment slot. Also, blockTag should be a slot number.
    destinationChainId ??= this.chainId;
    return fillStatusArray(this.programId, relayData, destinationChainId, this.svmEventsClient, atHeight, this.logger);
  }
}
