import AbstractApiClient from "./abstractClient";
import { BigNumber, fetchJsonWithTimeout, parseEther } from "../utils";
import {
  CoingeckoDataReturnType,
  SuggestedFeeReturnType,
  BridgeLimitsReturnType,
  AcrossBridgeStatisticsType,
} from "./types";

type SuggestedFeesApiResponse = {
  relayFeePct: string;
  relayFeeTotal: string;
  capitalFeePct: string;
  capitalFeeTotal: string;
  relayGasFeePct: string;
  relayGasFeeTotal: string;
  isAmountTooLow: boolean;
  timestamp: string;
  quoteBlock: string;
};

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
    const result = await fetchJsonWithTimeout<{ price: string }>(`${this.getServerlessApiUrl()}/api/coingecko`, {
      l1Token,
      baseCurrency,
    });
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
    const result = await fetchJsonWithTimeout<SuggestedFeesApiResponse>(`${this.getServerlessApiUrl()}/api/suggested-fees`, {
      token: originToken,
      destinationChainId: String(toChainid),
      originChainId: String(fromChainid),
      amount: amount.toString(),
      skipAmountLimit: "true",
    });
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
    const data = await fetchJsonWithTimeout<BridgeLimitsReturnType>(`${this.getServerlessApiUrl()}/api/limits`, {
      token,
      originChainId: fromChainId,
      destinationChainId: toChainId,
    });
    return data;
  }
  public async getAcrossStats(): Promise<AcrossBridgeStatisticsType> {
    const data = await fetchJsonWithTimeout<AcrossBridgeStatisticsType>(`${this.getScraperApiUrl()}/deposits/stats`);
    return data;
  }
}
