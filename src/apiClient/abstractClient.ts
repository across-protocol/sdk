import { ethers } from "ethers";
import {
  CoingeckoDataReturnType,
  SuggestedFeeReturnType,
  BridgeLimitsReturnType,
  AcrossBridgeStatisticsType,
} from "./types";

/**
 * AbstractApiClient is an abstract class that defines the interface for the API client.
 */
export default abstract class AbstractApiClient {
  /**
   * serverlessApiUrl is the URL of the serverless API.
   */
  private readonly serverlessApiUrl: string;
  /**
   * scraperApiUrl is the URL of the scraper API.
   */
  private readonly scraperApiUrl: string;

  /**
   * Creates a new instance of AbstractApiClient.
   * @param serverlessApiUrl The URL of the serverless API.
   * @param scraperApiUrl The URL of the scraper API.
   */
  protected constructor(serverlessApiUrl: string, scraperApiUrl: string) {
    this.serverlessApiUrl = serverlessApiUrl;
    this.scraperApiUrl = scraperApiUrl;
  }

  /**
   * Returns the URL of the serverless API.
   * @returns The URL of the serverless API.
   */
  protected getServerlessApiUrl(): string {
    return this.serverlessApiUrl;
  }

  /**
   * Returns the URL of the scraper API.
   * @returns The URL of the scraper API.
   */
  protected getScraperApiUrl(): string {
    return this.scraperApiUrl;
  }

  /**
   * Returns the coingecko data for the given token.
   * @param l1Token The token to get the coingecko data for.
   * @param baseCurrency The base currency to get the coingecko data for.
   * @returns The coingecko data.
   * @throws Throws an error if the API call fails.
   */
  public abstract getCoinGeckoData(l1Token: string, baseCurrency: string): Promise<CoingeckoDataReturnType>;

  /**
   * Returns the suggested fees for the given token and amount to transfer to the given chain in a bridge transfer.
   * @param amount The amount to transfer.
   * @param originToken The token to transfer.
   * @param toChainid The chain to transfer to
   * @param fromChainid The chain to transfer from
   * @returns The suggested fees.
   * @throws Throws an error if the API call fails.
   */
  public abstract getSuggestedFees(
    amount: ethers.BigNumber,
    originToken: string,
    toChainid: number,
    fromChainid: number
  ): Promise<SuggestedFeeReturnType>;

  /**
   * Returns the bridge limits for the given token and chain on Across.
   * @class
   * @abstract
   * @param token The token to get the bridge limits for.
   * @param fromChainId The chain that the transfer will originate from.
   * @param toChainId The chain that the transfer will be bridged to.
   * @returns The bridge limits.
   * @throws Throws an error if the API call fails.
   */
  public abstract getBridgeLimits(
    token: string,
    fromnumber: string | number,
    tonumber: string | number
  ): Promise<BridgeLimitsReturnType>;

  /**
   * Returns the Across bridge statistics. These are a set of statistics that are used to capture the current state of the bridge.
   * @returns The Across bridge statistics.
   * @throws Throws an error if the API call fails.
   */
  public abstract getAcrossStats(): Promise<AcrossBridgeStatisticsType>;
}
