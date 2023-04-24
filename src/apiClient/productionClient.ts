import axios from "axios";
import { ethers } from "ethers";
import AbstractApiClient from "./abstractClient";
import {
  CoingeckoDataReturnType,
  SuggestedFeeReturnType,
  BridgeLimitsReturnType,
  AcrossBridgeStatisticsType,
} from "./types";

/**
 * An implementation of AbstractApiClient that uses the production API.
 * @class
 * @extends AbstractApiClient
 * @note This implementation makes API calls to RESTful services.
 */
export default class ProductionApiClient extends AbstractApiClient {
  public constructor(serverlessApiUrl: string, scraperApiUrl: string) {
    super(serverlessApiUrl, scraperApiUrl);
  }

  public async getCoinGeckoData(l1Token: string, baseCurrency: string): Promise<CoingeckoDataReturnType> {
    const response = await axios.get(`${this.getServerlessApiUrl()}/api/coingecko`, {
      params: {
        l1Token,
        baseCurrency,
      },
    });
    const result = response.data;
    const price =
      baseCurrency === "usd" ? ethers.utils.parseEther(String(result.price)) : ethers.BigNumber.from(result.price);
    return {
      price,
    };
  }
  public async getSuggestedFees(
    amount: ethers.BigNumber,
    originToken: string,
    toChainid: number,
    fromChainid: number
  ): Promise<SuggestedFeeReturnType> {
    const response = await axios.get(`${this.getServerlessApiUrl()}/api/suggested-fees`, {
      params: {
        token: originToken,
        destinationChainId: toChainid,
        originChainId: fromChainid,
        amount: amount.toString(),
        skipAmountLimit: true,
      },
    });
    const result = response.data;
    const relayFeePct = ethers.BigNumber.from(result["relayFeePct"]);
    const relayFeeTotal = ethers.BigNumber.from(result["relayFeeTotal"]);

    const capitalFeePct = ethers.BigNumber.from(result["capitalFeePct"]);
    const capitalFeeTotal = ethers.BigNumber.from(result["capitalFeeTotal"]);

    const relayGasFeePct = ethers.BigNumber.from(result["relayGasFeePct"]);
    const relayGasFeeTotal = ethers.BigNumber.from(result["relayGasFeeTotal"]);

    const isAmountTooLow = result["isAmountTooLow"];

    const quoteTimestamp = ethers.BigNumber.from(result["timestamp"]);
    const quoteBlock = ethers.BigNumber.from(result["quoteBlock"]);

    return {
      relayerFee: {
        pct: relayFeePct,
        total: relayFeeTotal,
      },
      relayerCapitalFee: {
        pct: capitalFeePct,
        total: capitalFeeTotal,
      },
      relayerGasFee: {
        pct: relayGasFeePct,
        total: relayGasFeeTotal,
      },
      isAmountTooLow,
      quoteTimestamp,
      quoteBlock,
    };
  }
  public async getBridgeLimits(
    token: string,
    fromChainId: string | number,
    toChainId: string | number
  ): Promise<BridgeLimitsReturnType> {
    const { data } = await axios.get<BridgeLimitsReturnType>(
      `${this.getServerlessApiUrl()}/api/limits?token=${token}&originChainId=${fromChainId}&destinationChainId=${toChainId}`
    );
    return data;
  }
  public async getAcrossStats(): Promise<AcrossBridgeStatisticsType> {
    const axiosResponse = await axios.get<AcrossBridgeStatisticsType>(`${this.getScraperApiUrl()}/deposits/stats`);
    return axiosResponse.data;
  }
}
