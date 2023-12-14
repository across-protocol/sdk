import { CachingMechanismInterface } from "../interfaces";
import { isDefined } from "../utils";

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
  constructor(protected cachingMechanism?: CachingMechanismInterface) {
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
