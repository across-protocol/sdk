import { providers } from "ethers";
import { CachingMechanismInterface } from "../interfaces";
import { EventSearchConfig, isDefined, MakeOptional } from "../utils";
import { getNearestSlotTime, SVMProvider } from "../arch/svm";

export enum UpdateFailureReason {
  NotReady,
  AlreadyUpdated,
  BadRequest,
  RPCError,
}

export function isUpdateFailureReason(x: EventSearchConfig | UpdateFailureReason): x is UpdateFailureReason {
  return Number.isInteger(x);
}

/**
 * Base class for all clients to extend.
 */
export abstract class BaseAbstractClient {
  protected _isUpdated: boolean;
  public firstHeightToSearch = 0;
  public latestHeightSearched = 0;

  /**
   * Creates a new client.
   * @param cachingMechanism The caching mechanism to use for this client. If not provided, the client will not rely on an external cache.
   */
  constructor(
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 },
    protected cachingMechanism?: CachingMechanismInterface
  ) {
    this._isUpdated = false;
  }

  /**
   * Indicates whether the client has been updated since it was created.
   * @returns Whether the client has been updated since it was created.
   */
  public get isUpdated(): boolean {
    return this._isUpdated;
  }

  /**
   * Sets whether the client has been updated since it was created.
   * @param value Whether the client has been updated since it was created.
   * @throws Error if the client has already been updated and the value is false.
   */
  public set isUpdated(value: boolean) {
    if (this._isUpdated === true && !value) {
      throw new Error("Cannot set isUpdated to false once it is true");
    }
    this._isUpdated = value;
  }

  /**
   * Validates and updates the stored EventSearchConfig in advance of an update() call.
   * Use isEventSearchConfig() to discriminate the result.
   * @provider Ethers RPC provider instance.
   * @returns An EventSearchConfig instance if valid, otherwise an UpdateFailureReason.
   */
  public async updateSearchConfig(
    provider: providers.Provider | SVMProvider
  ): Promise<EventSearchConfig | UpdateFailureReason> {
    const from = this.firstHeightToSearch;
    let { to } = this.eventSearchConfig;
    if (isDefined(to)) {
      if (from > to) {
        throw new Error(`Invalid event search config from (${from}) > to (${to})`);
      }
    } else {
      if (provider instanceof providers.Provider) {
        to = await provider.getBlockNumber();
      } else {
        const { slot } = await getNearestSlotTime(provider);
        to = Number(slot);
      }
      if (to < from) {
        return UpdateFailureReason.AlreadyUpdated;
      }
    }

    const { maxLookBack } = this.eventSearchConfig;
    return { from, to, maxLookBack };
  }

  /**
   * Asserts that the client has been updated.
   */
  protected assertUpdated(): void {
    if (!this.isUpdated) {
      throw new Error("Client not updated");
    }
  }

  /**
   * Determines if the client has an external cache.
   * @returns Whether the client has an external cache.
   */
  protected hasCachingMechanism(): boolean {
    return isDefined(this.cachingMechanism);
  }
}
