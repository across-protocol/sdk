import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

export { EVMSpokePoolClient } from "./EVMSpokePoolClient";
export { SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";

/**
 * Checks if a SpokePoolClient is an EVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an EVMSpokePoolClient, false otherwise.
 */
export function isEVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is EVMSpokePoolClient {
  return spokePoolClient instanceof EVMSpokePoolClient;
}
