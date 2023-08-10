import assert from "assert";
import winston from "winston";
import { Contract, Event, ethers } from "ethers";
import { EventSearchConfig, MakeOptional, isDefined, utf8ToHex } from "../../utils";
import {
  AcrossConfigStoreClient,
  ConfigStoreUpdate,
  DEFAULT_CONFIG_STORE_VERSION,
  GLOBAL_CONFIG_STORE_KEYS,
} from "../AcrossConfigStoreClient";
import { EventManager, getEventManager } from "./MockEvents";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public configStoreVersion = DEFAULT_CONFIG_STORE_VERSION;
  private eventManager: EventManager | null;
  private events: Event[] = [];
  private ubaActivationBlockOverride: number | undefined;
  private availableChainIdsOverride: number[] | undefined;

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    OwnershipTransferred: "address,address",
    UpdatedGlobalConfig: "bytes32,string",
    UpdatedTokenConfig: "address,string",
  };

  constructor(
    logger: winston.Logger,
    configStore: Contract,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    configStoreVersion: number,
    chainId = 1,
    mockUpdate = false,
    availableChainIdsOverride?: number[]
  ) {
    super(logger, configStore, eventSearchConfig, configStoreVersion);
    this.chainId = chainId;
    this.eventManager = mockUpdate ? getEventManager(chainId, this.eventSignatures) : null;
    if (isDefined(this.eventManager) && this.eventManager) {
      this.updateGlobalConfig(
        GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES,
        JSON.stringify(availableChainIdsOverride),
        this.eventManager.blockNumber
      );
    }
  }

  setAvailableChains(chainIds: number[]): void {
    this.availableChainIdsOverride = chainIds;
  }

  getChainIdIndicesForBlock(block?: number): number[] {
    return this.availableChainIdsOverride ?? super.getChainIdIndicesForBlock(block);
  }

  setUBAActivationBlock(blockNumber: number | undefined): void {
    this.ubaActivationBlockOverride = blockNumber;
  }

  getUBAActivationBlock(): number | undefined {
    return this.ubaActivationBlockOverride ?? super.getUBAActivationBlock();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getConfigStoreVersionForBlock(_blockNumber: number): number {
    return this.configStoreVersion === DEFAULT_CONFIG_STORE_VERSION
      ? super.getConfigStoreVersionForBlock(_blockNumber)
      : this.configStoreVersion;
  }

  setConfigStoreVersion(version: number): void {
    this.configStoreVersion = version;
  }

  addEvent(event: Event): void {
    this.events.push(event);
  }

  async _update(): Promise<ConfigStoreUpdate> {
    // Backwards compatibility for pre-existing MockConfigStoreClient users.
    if (this.eventManager === null) {
      return super._update();
    }

    const eventNames = ["UpdatedGlobalConfig", "UpdatedTokenConfig"];
    const latestBlockNumber = this.eventManager.blockNumber;

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const globalConfigUpdateTimes: number[] = [];
    const _events: Event[][] = eventNames.map(() => []);
    for (const event of this.events.flat()) {
      const idx = eventNames.indexOf(event.event as string);
      if (idx !== -1) {
        _events[idx].push(event);
      }

      if (event.event === "UpdatedGlobalConfig") {
        const block = await event.getBlock();
        globalConfigUpdateTimes.push(block.timestamp);
      }
    }
    this.events = [];

    // Transform 2d-events array into a record.
    const events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, _events[idx]]));

    return {
      success: true,
      chainId: this.chainId as number,
      latestBlockNumber,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
      events: {
        updatedGlobalConfigEvents: events["UpdatedGlobalConfig"],
        globalConfigUpdateTimes,
        updatedTokenConfigEvents: events["UpdatedTokenConfig"],
      },
    };
  }

  updateGlobalConfig(key: string, value: string, blockNumber?: number): Event {
    return this.generateConfig("UpdatedGlobalConfig", utf8ToHex(key), value, blockNumber);
  }

  updateTokenConfig(key: string, value: string, blockNumber?: number): Event {
    // Verify that the key is a valid address
    if (ethers.utils.isAddress(key) === false) {
      throw new Error(`Invalid address: ${key}`);
    }
    return this.generateConfig("UpdatedTokenConfig", key, value, blockNumber);
  }

  private generateConfig(event: string, key: string, value: string, blockNumber?: number): Event {
    assert(this.eventManager !== null);

    const topics = [key, value];
    const args = { key, value };

    const configEvent = this.eventManager.generateEvent({
      event,
      address: this.configStore.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
    });

    this.addEvent(configEvent);
    return configEvent;
  }
}
