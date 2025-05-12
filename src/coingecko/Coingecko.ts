import axios, { AxiosError } from "axios";
import assert from "assert";
import get from "lodash.get";
import { getCoingeckoTokenIdByAddress, retry } from "../utils";
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

type CGTokenPrice = {
  [currency: string]: number;
  last_updated_at: number;
};

export type CoinGeckoTokenList = {
  id: string;
  symbol: string;
  name: string;
  platforms: {
    [platform: string]: string;
  };
};

export type PriceHistory = {
  market_data: {
    current_price: {
      [currency: string]: number;
    };
  };
};

export type HistoricPriceChartData = {
  prices: Array<[number, number]>;
  market_caps: Array<[number, number]>;
  total_volumes: Array<[number, number]>;
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
  private platformIdMap = new Map<number, string>(); // chainId => platform_id (137 => "polygon-pos")
  private tokenIdMap: Record<string, Record<string, string>> = {}; // coinGeckoId => { platform_id : "tokenAddress":}

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

  protected async getPlatformId(chainId: number): Promise<string> {
    let id = this.platformIdMap.get(chainId);

    if (id) {
      return id;
    }

    const platforms = await this.getPlatforms();
    this.platformIdMap = new Map(
      platforms.filter((chain) => Boolean(chain.chain_identifier)).map((chain) => [chain.chain_identifier, chain.id])
    );

    id = this.platformIdMap.get(chainId);
    if (!id) {
      this.logger.error({
        message: `Coingecko does not support chain with id ${chainId}`,
        at: "Coingecko#getPlatformId",
      });
      throw new Error(`Coingecko does not support chain with id ${chainId}`);
    }

    return id;
  }

  // for tokens not found in our constants, we can attempt to fetch the id from coingecko itself
  protected async getCoingeckoTokenId(address: string, chainId: number): Promise<string> {
    let id: string | undefined;
    try {
      id = getCoingeckoTokenIdByAddress(address, chainId);

      return id;
    } catch (error) {
      this.logger.warn({
        at: "Coingecko#getCoingeckoTokenIdByAddress",
        message: `Token with address ${address} not found in constants. Attempting to fetch ID from coingecko API...`,
      });
    }

    const platformId = await this.getPlatformId(chainId);

    id = this.getTokenIdFromAddress(address, platformId);

    if (id) {
      return id;
    }
    await this.updateTokenMap();

    id = this.getTokenIdFromAddress(address, platformId);

    if (!id) {
      const message = `Coin with address ${address} does not exist on chain with id ${chainId}`;
      this.logger.error({
        at: "Coingecko#getCoingeckoTokenIdByAddress",
        message,
      });
      throw new Error(message);
    }

    return id;
  }

  getTokenIdFromAddress(address: string, platformId: string): string | undefined {
    return Object.entries(this.tokenIdMap).find(([_, value]) =>
      Boolean(value?.[platformId]?.toLowerCase() === address.toLowerCase())
    )?.[0];
  }

  async updateTokenMap(): Promise<typeof this.tokenIdMap> {
    const rawTokenList = await this.call<Array<CoinGeckoTokenList>>("coins/list?include_platform=true");
    this.tokenIdMap = Object.fromEntries(
      rawTokenList
        .filter((token) => Boolean(Object.values(token?.platforms)?.length > 0))
        .map((token) => [token.id, token.platforms])
    );

    return this.tokenIdMap;
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
    const result = await this.call<HistoricPriceChartData>(
      `coins/ethereum/contract/${contract.toLowerCase()}/market_chart/range/?vs_currency=${currency}&from=${_from}&to=${_to}`
    );
    // fyi timestamps are returned in ms in contrast to the current price endpoint
    if (result.prices) return result.prices;
    throw new Error("Something went wrong fetching coingecko prices!");
  }

  /**
   * Get the current price of a token denominated in `currency`.
   * @param contractAddress The L1 token address to fetch the price for.
   * @param date A datestring in the format "dd-mm-yyyy" to fetch the price for.
   * @param currency The currency to fetch the price in. Defaults to "usd".
   * @returns The price of the token at the given date.
   * @throws If today is selected and it is before 3am UTC or if the price is not found.
   */
  async getContractHistoricDayPrice(
    contractAddress: string,
    date: string,
    currency = "usd",
    chainId = 1
  ): Promise<number> {
    const coingeckoTokenIdentifier = await this.getCoingeckoTokenId(contractAddress, chainId);
    assert(date, "Requires date string");
    // Build the path for the Coingecko API request
    const url = `coins/${coingeckoTokenIdentifier}/history`;
    // Build the query parameters for the Coingecko API request
    const queryParams = {
      date,
      localization: "false",
    };
    // Grab the result - parse out price, market cap, total volume, and timestamp
    const result = await this.call<PriceHistory>(`${url}?${new URLSearchParams(queryParams).toString()}`);
    const price = result?.market_data?.current_price?.[currency];
    assert(price, `No price found for ${contractAddress} on ${date}`);
    return price;
  }

  getContractDetails(contract_address: string, platform_id = "ethereum") {
    return this.call(`coins/${platform_id}/contract/${contract_address.toLowerCase()}`);
  }

  async getCurrentPriceByContract(contractAddress: string, currency = "usd", chainId = 1): Promise<[string, number]> {
    const platform_id = await this.getPlatformId(chainId);
    const priceCache: { [addr: string]: CoinGeckoPrice } = this.getPriceCache(currency, platform_id);
    let tokenPrice = this.getCachedAddressPrice(contractAddress, currency, platform_id);
    if (tokenPrice === undefined) {
      await this.getContractPrices([contractAddress], currency, platform_id);
      tokenPrice = priceCache[contractAddress];
    }

    assert(tokenPrice !== undefined);
    return [tokenPrice.timestamp.toString(), tokenPrice.price];
  }

  async getCurrentPriceById(contractAddress: string, currency = "usd", chainId = 1): Promise<[string, number]> {
    const platform_id = await this.getPlatformId(chainId);
    const priceCache = this.getPriceCache(currency, platform_id);
    let tokenPrice = this.getCachedAddressPrice(contractAddress, currency, platform_id);
    if (tokenPrice === undefined) {
      const coingeckoId = await this.getCoingeckoTokenId(contractAddress, chainId);
      // Build the path for the Coingecko API request
      const result = await this.call<Record<string, CGTokenPrice>>(
        `simple/price?ids=${coingeckoId}&vs_currencies=${currency}&include_last_updated_at=true`
      );
      const cgPrice = result?.[coingeckoId];
      if (cgPrice === undefined || !cgPrice?.[currency]) {
        const errMsg = `No price found for ${coingeckoId}`;
        this.logger.debug({
          at: "Coingecko#getCurrentPriceById",
          message: errMsg,
        });
        throw new Error(errMsg);
      } else {
        this.updatePriceCache(cgPrice, contractAddress, currency, platform_id);
      }
    }
    tokenPrice = priceCache[contractAddress];
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
        at: "Coingecko#getContractPrices",
        message: errMsg,
        tokens: contract_addresses,
      });
      throw new Error(errMsg);
    }

    // Note: contract_addresses is a reliable reference for the price lookup.
    // priceCache might have been updated subsequently by concurrent price requests.
    contract_addresses.forEach((addr) => {
      const cgPrice: CGTokenPrice | undefined = result[addr.toLowerCase()];
      if (cgPrice === undefined) {
        this.logger.debug({
          at: "Coingecko#getContractPrices",
          message: `Token ${addr} not included in CoinGecko response.`,
        });
      } else {
        this.updatePriceCache(cgPrice, addr, currency, platform_id);
      }
    });
    return addresses.map((addr: string) => priceCache[addr]);
  }

  getPlatforms(): Promise<CoinGeckoAssetPlatform[]> {
    return this.call("asset_platforms");
  }

  call<T>(path: string): Promise<T> {
    const sendRequest = async () => {
      const { proHost } = this;

      // If no pro api key, only send basic request:
      if (this.apiKey === undefined) {
        return (await this._callBasic(path)) as T;
      }

      // If pro api key, try basic and use pro as fallback.
      try {
        return (await this._callBasic(path, this.basicApiTimeout)) as T;
      } catch (err) {
        this.logger.debug({
          at: "sdk/coingecko",
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

  protected getCachedAddressPrice(
    contractAddress: string,
    currency: string,
    platform_id: string
  ): CoinGeckoPrice | undefined {
    const priceCache = this.getPriceCache(currency, platform_id);
    const now: number = msToS(Date.now());
    const tokenPrice: CoinGeckoPrice | undefined = priceCache[contractAddress];
    if (tokenPrice === undefined || tokenPrice.timestamp + this.maxPriceAge <= now) {
      if (this.maxPriceAge > 0) {
        this.logger.debug({
          at: "Coingecko#getCachedAddressPrice",
          message: `Cache miss on ${platform_id}/${currency} for ${contractAddress}`,
          maxPriceAge: this.maxPriceAge,
          tokenPrice: tokenPrice,
        });
      }
      return undefined;
    } else {
      this.logger.debug({
        at: "Coingecko#getCachedAddressPrice",
        message: `Cache hit on token ${contractAddress} (age ${now - tokenPrice.timestamp} S).`,
        price: tokenPrice,
      });
      return tokenPrice;
    }
  }

  protected updatePriceCache(cgPrice: CGTokenPrice, contractAddress: string, currency: string, platform_id: string) {
    const priceCache = this.getPriceCache(currency, platform_id);
    if (priceCache[contractAddress] === undefined) {
      priceCache[contractAddress] = { address: contractAddress, price: 0, timestamp: 0 };
    }
    if (cgPrice.last_updated_at > priceCache[contractAddress].timestamp) {
      priceCache[contractAddress] = {
        address: contractAddress,
        price: cgPrice[currency],
        timestamp: cgPrice.last_updated_at,
      };
      this.logger.debug({
        at: "Coingecko#updatePriceCache",
        message: `Updated ${platform_id}/${currency}/${contractAddress} token price cache.`,
      });
    } else {
      this.logger.debug({
        at: "Coingecko#updatePriceCache",
        message: `No new price available for token ${contractAddress}.`,
        token: cgPrice,
      });
    }
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
