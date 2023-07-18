/* eslint-disable @typescript-eslint/no-unused-vars */
import { ethers } from "ethers";
import { deepCopy } from "ethers/lib/utils";
import AbstractApiClient from "./abstractClient";
import {
  AcrossBridgeStatisticsType,
  BridgeLimitsReturnType,
  CoingeckoDataReturnType,
  EndpointResultMappingType,
  SuggestedFeeReturnType,
} from "./types";

/**
 * MockedApiClient is a mocked implementation of the AbstractApiClient.
 * @class
 * @extends AbstractApiClient
 * @note This implementation does not make API calls to RESTful services. Instead, it returns mocked data.
 */
export default class MockedApiClient extends AbstractApiClient {
  /**
   * Mocked data to return in lieu of the default return values.
   */
  private readonly mockedData: Partial<EndpointResultMappingType>;

  /**
   * Creates a constructor for the MockedApiClient.
   * @param mockedData The mocked data to return in lieu of the default return values
   */
  public constructor(mockedData?: Partial<EndpointResultMappingType>) {
    super("", "");
    this.mockedData = deepCopy(mockedData ?? {});
  }

  public getCoinGeckoData(_l1Token: string, _baseCurrency: string): Promise<CoingeckoDataReturnType> {
    return Promise.resolve(
      this.mockedData.CoinGeckoData ?? {
        price: ethers.utils.parseEther(String("0.1")),
      }
    );
  }
  public getSuggestedFees(
    _amount: ethers.BigNumber,
    _originToken: string,
    _toChainid: number,
    _fromChainid: number
  ): Promise<SuggestedFeeReturnType> {
    return Promise.resolve(
      this.mockedData.SuggestedFees ?? {
        relayerFee: {
          pct: ethers.constants.One,
          total: ethers.constants.One,
        },
        relayerCapitalFee: {
          pct: ethers.constants.One,
          total: ethers.constants.One,
        },
        relayerGasFee: {
          pct: ethers.constants.One,
          total: ethers.constants.One,
        },
        isAmountTooLow: false,
        quoteBlock: ethers.constants.One,
        quoteTimestamp: ethers.constants.One,
      }
    );
  }
  public getBridgeLimits(
    _token: string,
    _fromChainId: string | number,
    _toChainId: string | number
  ): Promise<BridgeLimitsReturnType> {
    return Promise.resolve(
      this.mockedData.BridgeLimits ?? {
        minDeposit: ethers.BigNumber.from("317845960607070"),
        maxDeposit: ethers.BigNumber.from("1625976243310274613043"),
        maxDepositInstant: ethers.BigNumber.from("148518401181482545509"),
        maxDepositShortDelay: ethers.BigNumber.from("1625976243310274613043"),
      }
    );
  }
  public getAcrossStats(): Promise<AcrossBridgeStatisticsType> {
    return Promise.resolve(
      this.mockedData.AcrossStats ?? {
        totalDeposits: 200,
        avgFillTime: 200,
        totalVolumeUsd: 100000,
      }
    );
  }
}
