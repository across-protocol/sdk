import { assertClientsAreUpdated } from "../utils";

/**
 * Base class for all clients to extend.
 */
export abstract class BaseAbstractClient {
  protected _isUpdated: boolean;

  /**
   * @param clientName The name of the client.
   * @param clientsRequiredToBeUpdated The clients that are required to be updated before this client can be updated.
   * @throws Error if the required clients are not updated.
   */
  constructor(
    readonly clientName?: string,
    clientsRequiredToBeUpdated: (BaseAbstractClient | undefined | null)[] = []
  ) {
    this._isUpdated = false;
    // Assert that the required clients are updated
    // Note: this function doesn't actually update the clients, it just asserts that they are updated
    //       as we are in the constructor and are not allowed to call async functions
    assertClientsAreUpdated(...clientsRequiredToBeUpdated);
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
}
