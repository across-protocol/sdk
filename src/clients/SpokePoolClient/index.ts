import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { SVMSpokePoolClient } from "./SVMSpokePoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

export { EVMSpokePoolClient } from "./EVMSpokePoolClient";
export { SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
export { SVMSpokePoolClient } from "./SVMSpokePoolClient";
export { SpokePoolManager } from "./SpokePoolClientManager";

export const EVM_SPOKE_POOL_CLIENT_TYPE = "EVM";
export const SVM_SPOKE_POOL_CLIENT_TYPE = "SVM";

/**
 * Checks if a SpokePoolClient is an EVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an EVMSpokePoolClient, false otherwise.
 */
export function isEVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is EVMSpokePoolClient {
  // @TODO: Shoud we handle the case where spokePoolClient is undefined?
  return spokePoolClient?.type === EVM_SPOKE_POOL_CLIENT_TYPE;
}

/**
 * Checks if a SpokePoolClient is an SVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an SVMSpokePoolClient, false otherwise.
 */
export function isSVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is SVMSpokePoolClient {
  // @TODO: Shoud we handle the case where spokePoolClient is undefined?
  return spokePoolClient?.type === SVM_SPOKE_POOL_CLIENT_TYPE;
}
