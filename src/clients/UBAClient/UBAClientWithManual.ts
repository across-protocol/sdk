// THIS CLASS HAS NO PURPOSE RIGHT NOW - IT WILL BE UPDATED IN THE FUTURE

/* eslint-disable @typescript-eslint/no-unused-vars */
import assert from "assert";
import winston from "winston";
import { RefundRequestWithBlock, UbaFlow } from "../../interfaces";
import { isDefined } from "../../utils";
import { BaseUBAClient, OpeningBalanceReturnType, RequestValidReturnType } from "./UBAClientAbstract";
import { BigNumber } from "ethers";
import { RelayerFeeDetails } from "../../relayFeeCalculator";

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

/**
 * UBAClient is a base class for UBA functionality. It provides a common interface for UBA functionality to be implemented on top of or extended.
 * It is intended to only be used directly when RPC calls are __***not***__ required, e.g. in tests, Scraper API.
 */
export class UBAClientManual extends BaseUBAClient {
  /**
   * Constructs a UBAClient instance.
   * @param chainIdIndices A list of available chain indices that should be reasoned about
   * @param state Manual state that acts as the source of truth in this model. Note that these are initial values and can be modified by extended class features
   * @param logger Optional logger to be used for logging
   */
  constructor(
    readonly chainIdIndices: number[],
    protected readonly state: UBAClientState,
    readonly logger?: winston.Logger
  ) {
    super(chainIdIndices, logger);
    assert(chainIdIndices.length > 0, "No chainIds provided");
    assert(Object.values(state.spoke).length > 0, "No SpokePools provided");
  }

  protected resolveClosingBlockNumber(chainId: number, blockNumber: number): number {
    return this.state.spoke[chainId].bundleEndBlocks.find((bundleEndBlock) => bundleEndBlock <= blockNumber) ?? -1;
  }

  public getOpeningBalance(
    chainId: number,
    spokePoolToken: string,
    hubPoolBlockNumber: number = Number.MAX_SAFE_INTEGER
  ): OpeningBalanceReturnType {
    const spoke = this.state.spoke[chainId];
    const token = spoke.openingBalances[spokePoolToken];
    if (!isDefined(token)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }
    const openingBalance = token
      .slice()
      .reverse()
      .find((balance) => !hubPoolBlockNumber || balance.blockNumber <= hubPoolBlockNumber);
    if (!isDefined(openingBalance)) {
      throw new Error(`Could not resolve ${chainId} token ${spokePoolToken} at block ${hubPoolBlockNumber}`);
    }
    const { blockNumber, balance: spokePoolBalance } = openingBalance;
    return { blockNumber, spokePoolBalance };
  }

  public getFlows(chainId: number, _fromBlock?: number, _toBlock?: number): UbaFlow[] {
    const { flows } = this.state.spoke[chainId];
    if (flows.length === 0) {
      return [];
    }
    const fromBlock = _fromBlock ?? 0;
    const toBlock = _toBlock ?? Number.MAX_SAFE_INTEGER;
    return flows.filter((flow) => flow.blockNumber >= fromBlock && flow.blockNumber <= toBlock);
  }

  public refundRequestIsValid(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _chainId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _refundRequest: RefundRequestWithBlock
  ): RequestValidReturnType {
    return { valid: true };
  }
  protected instantiateUBAFeeCalculator(_chainId: number, _token: string, _fromBlock: number): Promise<void> {
    throw new Error("Method not implemented.");
  }
  protected computeLpFee(
    _hubPoolTokenAddress: string,
    _depositChainId: number,
    _refundChainId: number,
    _amount: BigNumber
  ): Promise<BigNumber> {
    throw new Error("Method not implemented.");
  }
  protected computeRelayerFees(
    _tokenSymbol: string,
    _amount: BigNumber,
    _depositChainId: number,
    _refundChainId: number,
    _tokenPrice?: number | undefined
  ): Promise<RelayerFeeDetails> {
    throw new Error("Method not implemented.");
  }
}
