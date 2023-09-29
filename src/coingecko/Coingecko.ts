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

type PriceCache = {
  [chain: string]: {
    [currency: string]: {
      [address: string]: CoinGeckoPrice;
    };
  };
};

// Singleton Coingecko class.
export class Coingecko {
  private static instance: Coingecko | undefined;
  private prices: PriceCache;
  private _maxPriceAge = 300; // seconds

  // Retry configuration.
  private retryDelay = 1;
  private numRetries = 0; // Most failures are due to 429 rate-limiting, so there is no point in retrying.
  private basicApiTimeout = 500; // ms

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

  get maxPriceAge(): number {
    return this._maxPriceAge;
  }

  set maxPriceAge(age: number) {
    assert(age >= 0);
    this.logger.debug({
      at: "Coingecko#maxPriceAge",
      message: `Setting maxPriceAge (S) ${this._maxPriceAge} => ${age}.`,
    });
    this._maxPriceAge = age;
  }

  protected constructor(
    private readonly host: string,
    private readonly proHost: string,
    private readonly logger: Logger,
    private readonly apiKey?: string
  ) {
    this.prices = {};
  }

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
  getContractDetails(contract_address: string, platform_id = "ethereum") {
    return this.call(`coins/${platform_id}/contract/${contract_address.toLowerCase()}`);
  }
  async getCurrentPriceByContract(
    contract_address: string,
    currency = "usd",
    platform_id = "ethereum"
  ): Promise<[string, number]> {
    const priceCache: { [addr: string]: CoinGeckoPrice } = this.getPriceCache(currency, platform_id);
    const now: number = msToS(Date.now());
    let tokenPrice: CoinGeckoPrice | undefined = priceCache[contract_address];

    if (tokenPrice === undefined || tokenPrice.timestamp + this.maxPriceAge <= now) {
      if (this.maxPriceAge > 0) {
        this.logger.debug({
          at: "Coingecko#getCurrentPriceByContract",
          message: `Cache miss on ${platform_id}/${currency} for ${contract_address}`,
          maxPriceAge: this.maxPriceAge,
          tokenPrice: tokenPrice,
        });
      }

      await this.getContractPrices([contract_address], currency, platform_id);
      tokenPrice = priceCache[contract_address];
    } else {
      this.logger.debug({
        at: "Coingecko#getCurrentPriceByContract",
        message: `Cache hit on token ${contract_address} (age ${now - tokenPrice.timestamp} S).`,
        price: tokenPrice,
      });
    }

    assert(tokenPrice !== undefined);
    return [tokenPrice.timestamp.toString(), tokenPrice.price];
  }
  // Return an array of spot prices for an array of collateral addresses in one async call. Note we might in future
  // This was adapted from packages/merkle-distributor/kpi-options-helpers/calculate-uma-tvl.ts
  async getContractPrices(
    addresses: Array<string>,
    currency = "usd",
    platform_id = "ethereum"
  ): Promise<CoinGeckoPrice[]> {
    const priceCache: { [addr: string]: CoinGeckoPrice } = this.getPriceCache(currency, platform_id);

    // Pre-populate price cache with requested token addresses
    addresses.forEach((addr: string) => {
      if (priceCache[addr] === undefined) {
        priceCache[addr] = { address: addr, price: 0, timestamp: 0 };
      }
    });

    // Collect all known token addresses (requested + other cached).
    const contract_addresses: string[] = Object.keys(priceCache);
    assert(contract_addresses.length > 0, "Must supply at least 1 contract address");
    this.logger.debug({
      at: "Coingecko#getContractPrices",
      message: `Updating ${platform_id}/${currency} token prices.`,
      tokens: contract_addresses,
    });

    // annoying, but have to type this to iterate over entries
    type CGTokenPrice = {
      [currency: string]: number;
      last_updated_at: number;
    };
    type Result = {
      [address: string]: CGTokenPrice;
    };

    let result: Result = {};
    try {
      // Coingecko expects a comma-delimited (%2c) list.
      result = await this.call(
        `simple/token_price/${platform_id}?contract_addresses=${contract_addresses.join(
          "%2C"
        )}&vs_currencies=${currency}&include_last_updated_at=true`
      );
    } catch (err) {
      const errMsg = `Failed to retrieve ${platform_id}/${currency} prices (${err})`;
      this.logger.debug({
        at: "Coingecko#getCurrentPriceByContract",
        message: errMsg,
        tokens: contract_addresses,
      });
      throw new Error(errMsg);
    }

    // Note: contract_addresses is a reliable reference for the price lookup.
    // priceCache might have been updated subsequently by concurrent price requests.
    const updated: string[] = [];
    contract_addresses.forEach((addr) => {
      const cgPrice: CGTokenPrice | undefined = result[addr.toLowerCase()];

      if (cgPrice === undefined) {
        this.logger.debug({
          at: "Coingecko#getContractPrices",
          message: `Token ${addr} not included in CoinGecko response.`,
        });
      } else if (cgPrice.last_updated_at > priceCache[addr].timestamp) {
        priceCache[addr] = {
          address: addr,
          price: cgPrice[currency],
          timestamp: cgPrice.last_updated_at,
        };
        updated.push(addr);
      } else if (cgPrice.last_updated_at === priceCache[addr].timestamp) {
        this.logger.debug({
          at: "Coingecko#getContractPrices",
          message: `No new price available for token ${addr}.`,
          token: cgPrice,
        });
      }
    });

    if (updated.length > 0) {
      this.logger.debug({
        at: "Coingecko#updatePriceCache",
        message: `Updated ${platform_id}/${currency} token price cache.`,
        tokens: updated,
      });
    }
    return addresses.map((addr: string) => priceCache[addr]);
  }

  getPlatforms(): Promise<CoinGeckoAssetPlatform[]> {
    return this.call("asset_platforms");
  }

  call(path: string) {
    const sendRequest = async () => {
      const { proHost } = this;

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

  protected getPriceCache(currency: string, platform_id: string): { [addr: string]: CoinGeckoPrice } {
    if (this.prices[platform_id] === undefined) this.prices[platform_id] = {};
    if (this.prices[platform_id][currency] === undefined) this.prices[platform_id][currency] = {};
    return this.prices[platform_id][currency];
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
