/**
 * Base class for all clients to extend.
 */
export abstract class BaseAbstractClient {
  private _isUpdated: boolean;

  constructor() {
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
  protected set isUpdated(value: boolean) {
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
