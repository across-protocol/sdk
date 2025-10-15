import winston from "winston";
import { SpokePoolClient } from "./SpokePoolClient";
import { Address } from "../../utils";

/**
 * SpokePoolClientManager is a wrapper around spokePoolClients. We want to use wrapper almost always
 * instead of direct access to spokePoolClients because chainId can be invalid and we want to return undefined.
 */
export class SpokePoolManager {
  private spokePoolClients: { [chainId: number]: SpokePoolClient };

  constructor(
    readonly logger: winston.Logger,
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    this.spokePoolClients = spokePoolClients;
  }

  /**
   * Retrieves a SpokePoolClient for a given chainId.
   * @param chainId - The chainId of the spokePoolClient to retrieve.
   * @returns SpokePoolClient | undefined
   * @note This method returns SpokePoolClient for given chainId. If its not found, it returns undefined.
   */
  getClient(chainId: number): SpokePoolClient | undefined {
    return this.spokePoolClients[chainId];
  }

  /**
   * Retrieves all SpokePoolClients
   * @returns SpokePoolClient[]
   * @note This method returns all SpokePoolClients.
   */
  getSpokePoolClients(): { [chainId: number]: SpokePoolClient } {
    return this.spokePoolClients;
  }

  /**
   * Retrieves all SpokePoolClient Addresses
   * @returns (Address | undefined)[]
   * @note This method returns all SpokePoolClient Addresses.
   */
  getSpokePoolAddresses(): (Address | undefined)[] {
    return Object.values(this.spokePoolClients).map((client) => client.spokePoolAddress);
  }

  /**
   * Retrieves all SpokePoolClient chainIds
   * @returns number[]
   * @note This method returns all SpokePoolClient chainIds.
   */
  getChainIds(): number[] {
    return Object.keys(this.spokePoolClients).map(Number);
  }
}
