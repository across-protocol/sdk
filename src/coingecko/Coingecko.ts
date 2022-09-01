import axios, { AxiosError } from "axios";
import assert from "assert";
import get from "lodash.get";
import { retry } from "../utils";
import { Logger } from "../relayFeeCalculator";

export function msToS(ms: number) {
  return Math.floor(ms / 1000);
}

export type CoinGeckoAssetPlatform = {
  id: string;
  chain_identifier: number;
  name: string;
  shortname: string;
};

export type CoinGeckoPrice = {
  address: string;
  timestamp: number;
  price: number;
};

// Singleton Coingecko class.
export class Coingecko {
  private static instance: Coingecko | undefined;

  // Retry configuration.
  private retryDelay = 1;
  private numRetries = 0; // Most failures are due to 429 rate-limiting, so there is no point in retrying.
  private basicApiTimeout = 250; // ms

  public static get(logger: Logger, apiKey?: string) {
    if (!this.instance)
      this.instance = new Coingecko(
        "https://api.coingecko.com/api/v3",
        "https://pro-api.coingecko.com/api/v3",
        logger,
        apiKey
      );
    return this.instance;
  }

  private constructor(
    private readonly host: string,
    private readonly proHost: string,
    private readonly logger: Logger,
    private readonly apiKey?: string
  ) {}

  // Fetch historic prices for a `contract` denominated in `currency` between timestamp `from` and `to`. Note timestamps
  // are assumed to be js timestamps and are converted to unixtimestamps by dividing by 1000.
  async getHistoricContractPrices(contract: string, from: number, to: number, currency = "usd") {
    assert(contract, "requires contract address");
    assert(currency, "requires currency symbol");
    assert(from, "requires from timestamp");
    assert(to, "requires to timestamp");
    const _from = msToS(from);
    const _to = msToS(to);
    const result = await this.call(
      `coins/ethereum/contract/${contract.toLowerCase()}/market_chart/range/?vs_currency=${currency}&from=${_from}&to=${_to}`
    );
    // fyi timestamps are returned in ms in contrast to the current price endpoint
    if (result.prices) return result.prices;
    throw new Error("Something went wrong fetching coingecko prices!");
  }
  async getContractDetails(contract_address: string, platform_id = "ethereum") {
    return this.call(`coins/${platform_id}/contract/${contract_address.toLowerCase()}`);
  }
  async getCurrentPriceByContract(
    contract_address: string,
    currency = "usd",
    platform_id = "ethereum"
  ): Promise<[string, number]> {
    const result: CoinGeckoPrice[] = await this.getContractPrices([contract_address], currency, platform_id);
    return [result[0].timestamp.toString(), result[0].price];
  }
  // Return an array of spot prices for an array of collateral addresses in one async call. Note we might in future
  // This was adapted from packages/merkle-distributor/kpi-options-helpers/calculate-uma-tvl.ts
  async getContractPrices(
    addresses: Array<string>,
    currency = "usd",
    platform_id = "ethereum"
  ): Promise<CoinGeckoPrice[]> {
    // Generate a unique set with no repeated. join the set with the required coingecko delimiter.
    const contract_addresses = Array.from(new Set(addresses.filter((n) => n).values()));
    assert(contract_addresses.length > 0, "Must supply at least 1 contract address");
    // coingecko returns lowercase addresses, so if you expect checksummed addresses, this lookup table will convert them back without having to add ethers as a dependency
    const lookup = Object.fromEntries(
      contract_addresses.map((address) => {
        return [address.toLowerCase(), address];
      })
    );
    // annoying, but have to type this to iterate over entries
    type Result = {
      [address: string]: {
        usd: number;
        last_updated_at: number;
      };
    };
    const result: Result = await this.call(
      `simple/token_price/${platform_id}?contract_addresses=${contract_addresses.join(
        "%2C"
      )}&vs_currencies=${currency}&include_last_updated_at=true`
    );
    return Object.entries(result).map(([key, value]) => {
      return { address: lookup[key], timestamp: value.last_updated_at, price: value.usd };
    });
  }

  async getPlatforms(): Promise<CoinGeckoAssetPlatform[]> {
    return this.call("asset_platforms");
  }

  async call(path: string) {
    const sendRequest = async () => {
      const { host, proHost } = this;
      this.logger.debug({ at: "sdk-v2/coingecko", message: `Sending GET request to host ${host}` });

      // If no pro api key, only send basic request:
      if (this.apiKey === undefined) {
        return await this._callBasic(path);
      }

      // If pro api key, try basic and use pro as fallback.
      try {
        return await this._callBasic(path, this.basicApiTimeout);
      } catch (err) {
        this.logger.debug({
          at: "sdk-v2/coingecko",
          message: `Basic CG url request failed, falling back to CG PRO host ${proHost}`,
          errMessage: (err as AxiosError).message,
        });
        return await this._callPro(path);
      }
    };

    // Note: If a pro API key is configured, there is no need to retry as the Pro API will act as the basic's fall back.
    return retry(sendRequest, this.apiKey === undefined ? this.numRetries : 0, this.retryDelay);
  }

  private async _callBasic(path: string, timeout?: number) {
    const url = `${this.host}/${path}`;

    try {
      // Don't use timeout if there is no pro API to fallback to.
      const result = await axios(url, { timeout });
      return result.data;
    } catch (err) {
      const msg = get(err, "response.data.error", get(err, "response.statusText", (err as AxiosError).message));
      throw new Error(msg);
    }
  }

  private async _callPro(path: string) {
    const url = `${this.proHost}/${path}`;

    try {
      // Don't use timeout if there is no pro API to fallback to.
      const result = await axios(url, { params: { x_cg_pro_api_key: this.apiKey } });
      return result.data;
    } catch (err) {
      const msg = get(err, "response.data.error", get(err, "response.statusText", (err as AxiosError).message));
      throw new Error(msg);
    }
  }
}
