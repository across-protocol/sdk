import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { SVMSpokePoolClient } from "./SVMSpokePoolClient";
import { TVMSpokePoolClient } from "./TVMSpokePoolClient";
import { SpokePoolClient } from "./SpokePoolClient";
import { EVM_SPOKE_POOL_CLIENT_TYPE, SVM_SPOKE_POOL_CLIENT_TYPE, TVM_SPOKE_POOL_CLIENT_TYPE } from "./types";

export { EVMSpokePoolClient } from "./EVMSpokePoolClient";
export { SpokePoolClient, SpokePoolUpdate } from "./SpokePoolClient";
export { SVMSpokePoolClient } from "./SVMSpokePoolClient";
export { TVMSpokePoolClient } from "./TVMSpokePoolClient";
export { SpokePoolManager } from "./SpokePoolClientManager";

/**
 * Checks if a SpokePoolClient is an EVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an EVMSpokePoolClient, false otherwise.
 */
export function isEVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is EVMSpokePoolClient {
  // @TODO: Should we handle the case where spokePoolClient is undefined?
  return spokePoolClient?.type === EVM_SPOKE_POOL_CLIENT_TYPE;
}

/**
 * Checks if a SpokePoolClient is an SVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is an SVMSpokePoolClient, false otherwise.
 */
export function isSVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is SVMSpokePoolClient {
  // @TODO: Should we handle the case where spokePoolClient is undefined?
  return spokePoolClient?.type === SVM_SPOKE_POOL_CLIENT_TYPE;
}

/**
 * Checks if a SpokePoolClient is a TVMSpokePoolClient.
 * @param spokePoolClient The SpokePoolClient to check.
 * @returns True if the SpokePoolClient is a TVMSpokePoolClient, false otherwise.
 */
export function isTVMSpokePoolClient(spokePoolClient: SpokePoolClient): spokePoolClient is TVMSpokePoolClient {
  return spokePoolClient?.type === TVM_SPOKE_POOL_CLIENT_TYPE;
}
