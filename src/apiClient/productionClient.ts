import axios from "axios";
import AbstractApiClient from "./abstractClient";
import { BigNumber, parseEther } from "../utils";
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
    const price = baseCurrency === "usd" ? parseEther(String(result.price)) : BigNumber.from(result.price);
    return {
      price,
    };
  }
  public async getSuggestedFees(
    amount: BigNumber,
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
    const relayFeePct = BigNumber.from(result["relayFeePct"]);
    const relayFeeTotal = BigNumber.from(result["relayFeeTotal"]);

    const capitalFeePct = BigNumber.from(result["capitalFeePct"]);
    const capitalFeeTotal = BigNumber.from(result["capitalFeeTotal"]);

    const relayGasFeePct = BigNumber.from(result["relayGasFeePct"]);
    const relayGasFeeTotal = BigNumber.from(result["relayGasFeeTotal"]);

    const isAmountTooLow = result["isAmountTooLow"];

    const quoteTimestamp = BigNumber.from(result["timestamp"]);
    const quoteBlock = BigNumber.from(result["quoteBlock"]);

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
