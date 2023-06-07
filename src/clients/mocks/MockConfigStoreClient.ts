import winston from "winston";
import { Contract, Event } from "ethers";
import { random } from "lodash";
import { EventSearchConfig, utf8ToHex } from "../../utils";
import { AcrossConfigStoreClient, ConfigStoreUpdate, DEFAULT_CONFIG_STORE_VERSION } from "../AcrossConfigStoreClient";
import { EventManager } from "./MockEvents";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public readonly minBlockRange = 10;
  public configStoreVersion = DEFAULT_CONFIG_STORE_VERSION;
  private events: Event[] = [];
  private eventManager: EventManager;

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    OwnershipTransferred: "address,address",
    UpdatedGlobalConfig: "bytes32,string",
    UpdatedTokenConfig: "address,string",
  };

  constructor(
    logger: winston.Logger,
    configStore: Contract,
    eventSearchConfig: EventSearchConfig,
    configStoreVersion: number,
    enabledChainIds: number[],
    public readonly mockUpdate = false
  ) {
    super(logger, configStore, eventSearchConfig, configStoreVersion, enabledChainIds);
    this.eventManager = new EventManager(this.eventSignatures);
  }

  setConfigStoreVersion(version: number): void {
    this.configStoreVersion = version;
  }

  isValidConfigStoreVersion(_version: number): boolean {
    return this.configStoreVersion >= _version;
  }

  addEvent(event: Event): void {
    this.events.push(event);
  }

  async _update(): Promise<ConfigStoreUpdate> {
    // Backwards compatibility for pre-existing MockConfigStoreClient users.
    if (!this.mockUpdate) {
      return super._update();
    }

    const eventNames = ["UpdatedGlobalConfig", "UpdatedTokenConfig"];
    // Generate new "on chain" responses.
    const latestBlockNumber = (this.latestBlockNumber ?? 0) + random(this.minBlockRange, this.minBlockRange * 5, false);

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
      latestBlockNumber,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
      events: {
        updatedGlobalConfigEvents: events["UpdatedGlobalConfig"],
        globalConfigUpdateTimes,
        updatedTokenConfigEvents: events["UpdatedTokenConfig"],
      },
    };
  }

  updateGlobalConfig(key: string, value: string): Event {
    return this.generateConfig("UpdatedGlobalConfig", utf8ToHex(key), value);
  }

  updateTokenConfig(key: string, value: string): Event {
    return this.generateConfig("UpdatedTokenConfig", utf8ToHex(key), value);
  }

  private generateConfig(event: string, key: string, value: string): Event {
    const topics = [key, value];
    const args = { key, value };

    const configEvent = this.eventManager.generateEvent({
      event,
      address: this.configStore.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: this.latestBlockNumber + 1,
    });

    this.addEvent(configEvent);
    return configEvent;
  }
}
