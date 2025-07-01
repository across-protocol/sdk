import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { SVMSpokePoolClient } from "./SVMSpokePoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

export { EVMSpokePoolClient } from "./EVMSpokePoolClient";
export { SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
export { SVMSpokePoolClient } from "./SVMSpokePoolClient";
export { SpokePoolManager } from "./SpokePoolClientManager";

/**
 * Checks if a SpokePoolClient is an EVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an EVMSpokePoolClient, false otherwise.
 */
export function isEVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is EVMSpokePoolClient {
  return spokePoolClient instanceof EVMSpokePoolClient;
}

/**
 * Checks if a SpokePoolClient is an SVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an SVMSpokePoolClient, false otherwise.
 */
export function isSVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is SVMSpokePoolClient {
  return spokePoolClient instanceof SVMSpokePoolClient;
}
