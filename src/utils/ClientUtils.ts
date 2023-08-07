import { BaseAbstractClient } from "../clients/BaseAbstractClient";
import assert from "assert";

/**
 * Asserts that the clients are updated
 * @param clients The clients to check
 * @throws AssertionError if the clients are not updated
 */
export function assertClientsAreUpdated(...clients: BaseAbstractClient[]): void {
  clients.forEach((client) => assert(client.isUpdated, "Client is not updated"));
}
