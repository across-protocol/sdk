import { providers } from "ethers";
import { CachingMechanismInterface } from "../interfaces";
import { EventSearchConfig, isDefined, MakeOptional } from "../utils";

export enum UpdateFailureReason {
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
  public firstBlockToSearch = 0;
  public latestBlockSearched = 0;

  /**
   * Creates a new client.
   * @param cachingMechanism The caching mechanism to use for this client. If not provided, the client will not rely on an external cache.
   */
  constructor(
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
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
  public async updateSearchConfig(provider: providers.Provider): Promise<EventSearchConfig | UpdateFailureReason> {
    const fromBlock = this.firstBlockToSearch;
    let { toBlock } = this.eventSearchConfig;
    if (isDefined(toBlock)) {
      if (fromBlock > toBlock) {
        return UpdateFailureReason.BadRequest;
      }
    } else {
      try {
        toBlock = await provider.getBlockNumber();
      } catch (err) {
        return UpdateFailureReason.RPCError;
      }
      if (toBlock < fromBlock) {
        return UpdateFailureReason.AlreadyUpdated;
      }
    }

    const { maxBlockLookBack } = this.eventSearchConfig;
    return { fromBlock, toBlock, maxBlockLookBack };
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
