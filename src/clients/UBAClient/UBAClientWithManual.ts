import assert from "assert";
import winston from "winston";
import { BigNumber } from "ethers";
import { RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { isDefined } from "../../utils";

/**
 * UBAClientState is a type that represents the state of a UBAClient.
 */
type UBAClientState = {
  spoke: {
    [chainId: number]: {
      flows: UbaFlow[];
      latestBlockNumber: number;
      bundleEndBlocks: number[];
      openingBalances: {
        [token: string]: {
          blockNumber: number;
          balance: BigNumber;
        }[];
      };
    };
  };
};

export type RequestValidReturnType = { valid: false; reason: string } | { valid: true };
export type OpeningBalanceReturnType = { blockNumber: number; spokePoolBalance: BigNumber };

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * It is intended to only be used directly when RPC calls are __***not***__ required, e.g. in tests, Scraper API.
 */
export class UBAClientManual {
  /**
   * Constructs a UBAClient instance.
   * @param chainIdIndices A list of available chain indices that should be reasoned about
   * @param state Manual state that acts as the source of truth in this model. Note that these are initial values and can be modified by extended class features
   * @param logger Optional logger to be used for logging
   */
  constructor(
    protected readonly chainIdIndices: number[],
    protected readonly state: UBAClientState,
    protected readonly logger?: winston.Logger
  ) {
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(state.spoke).length > 0, "No SpokePools provided");
  }

  /**
   * Gets the latest block number for a given chainId in the state of the lastest closing block
   * @param chainId The chainId to get the latest block number for
   * @returns The latest block number for the given chainId
   * @note Assumes that the `spoke[...].bundleEndBlocks` are sorted in ascending order
   */
  protected resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    return this.state.spoke[chainId].bundleEndBlocks.find((bundleEndBlock) => bundleEndBlock <= blockNumber) ?? -1;
  }

  /**
   * Retrieves the opening balance for a given token on a given chainId at a given block number
   * @param chainId The chainId to get the opening balance for
   * @param spokePoolToken The token to get the opening balance for
   * @param hubPoolBlockNumber The block number to get the opening balance for
   * @returns The opening balance for the given token on the given chainId at the given block number
   * @throws If the token cannot be found for the given chainId
   * @throws If the opening balance cannot be found for the given token on the given chainId at the given block number
   */
  public getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber?: number
  ): OpeningBalanceReturnType {
    const spoke = this.state.spoke[chainId];
    const token = spoke.openingBalances[spokePoolToken];
    if (!isDefined(token)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }
    const openingBalance = token.findLast(
      (balance) => !hubPoolBlockNumber || balance.blockNumber <= hubPoolBlockNumber
    );
    if (!isDefined(openingBalance)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }
    const { blockNumber, balance: spokePoolBalance } = openingBalance;
    return { blockNumber, spokePoolBalance };
  }

  /**
   * @description Construct the ordered sequence of SpokePool flows between two blocks.
   * @note Assumptions:
   * @note Deposits, Fills and RefundRequests have been pre-verified by the SpokePool contract or SpokePoolClient, i.e.:
   * @note - Deposit events contain valid information.
   * @note - Fill events correspond to valid deposits.
   * @note - RefundRequest events correspond to valid fills.
   * @note In order to provide up-to-date prices, UBA functionality may want to follow close to "latest" and so may still
   * @note be exposed to finality risk. Additional verification that can only be performed within the UBA context:
   * @note - Only the first instance of a partial fill for a deposit is accepted. The total deposit amount is taken, and
   * @note   subsequent partial, complete or slow fills are disregarded.
   * @param spokePoolClient SpokePoolClient instance for this chain.
   * @param fromBlock       Optional lower bound of the search range. Defaults to the SpokePool deployment block.
   * @param toBlock         Optional upper bound of the search range. Defaults to the latest queried block.
   */
  public getFlows(chainId: number, fromBlock?: number, toBlock?: number): UbaFlow[] {
    const { flows } = this.state.spoke[chainId];
    if (flows.length === 0) {
      return [];
    }
    return flows.filter((flow) =>
      isDefined(fromBlock)
        ? flow.blockNumber >= fromBlock
        : true && isDefined(toBlock)
        ? flow.blockNumber <= toBlock
        : true
    );
  }

  /**
   * @description Evaluate an RefundRequest object for validity.
   * @dev  Callers should evaluate 'valid' before 'reason' in the return object.
   * @dev  The following RefundRequest attributes are not evaluated for validity and should be checked separately:
   * @dev  - previousIdenticalRequests
   * @dev  - Age of blockNumber (i.e. according to SpokePool finality)
   * @param chainId       ChainId of SpokePool where refundRequest originated.
   * @param refundRequest RefundRequest object to be evaluated for validity.
   */
  public refundRequestIsValid(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _chainId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _refundRequest: RefundRequestWithBlock
  ): RequestValidReturnType {
    return { valid: true };
  }
}
