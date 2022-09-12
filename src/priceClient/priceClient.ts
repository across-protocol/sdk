import assert from "assert";
import { CoinGeckoPrice } from "../coingecko";
import { Logger } from "../relayFeeCalculator"; // @todo: Relocate Logger to utils?

export { Logger } from "../relayFeeCalculator"; // Permit adapters to import a common definition.
export type TokenPrice = CoinGeckoPrice; // Temporary inversion; CoinGecko should source from here.

// Represents valid source for spot prices (Across API, CoinGecko, ...)
export interface PriceFeedAdapter {
  readonly name: string;
  getTokenPrice(address: string, currency: string, platform: string): Promise<TokenPrice>;
  getTokenPrices(addresses: string[], currency: string, platform: string): Promise<TokenPrice[]>;
}

export type PriceCache = {
  [address: string]: TokenPrice;
};

export function msToS(ms: number): number {
  return Math.floor(ms / 1000);
}

export class PriceClient implements PriceFeedAdapter {
  private static instance: PriceClient | undefined;
  public readonly name: string = "PriceClient";
  private _maxPriceAge = 300; // seconds
  private priceFeeds: PriceFeedAdapter[] = [];
  private prices: {
    [platform: string]: {
      [currency: string]: PriceCache;
    };
  } = {};

  protected constructor(protected logger: Logger) {}

  public static get(logger: Logger): PriceClient {
    if (!this.instance) this.instance = new PriceClient(logger);

    return this.instance;
  }

  get maxPriceAge(): number {
    return this._maxPriceAge;
  }

  set maxPriceAge(age: number) {
    assert(age >= 0);
    this.logger.debug({
      at: "PriceClient#maxPriceAge",
      message: `Setting maxPriceAge (S) ${this._maxPriceAge} => ${age}.`,
    });
    this._maxPriceAge = age;
  }

  // @todo: Could be nice to specify a priority rather than relying on order of addition.
  addPriceFeed(priceFeed: PriceFeedAdapter): void {
    assert(!this.priceFeeds.includes(priceFeed), `Price feed ${priceFeed.name} already registered.`);
    this.priceFeeds.push(priceFeed);
    this.logger.debug({
      at: "PriceClient#addPriceFeed",
      message: `Appended new price feed: ${priceFeed.name}.`,
    });
  }

  listPriceFeeds(): string[] {
    return this.priceFeeds.map((priceFeed: PriceFeedAdapter) => priceFeed.name);
  }

  clearPriceFeeds(): void {
    const cleared: string[] = this.priceFeeds.map((priceFeed: PriceFeedAdapter) => priceFeed.name);
    this.priceFeeds = [];
    this.logger.debug({
      at: "PriceClient#clearPriceFeeds",
      message: "Cleared all price feeds.",
      cleared,
    });
  }

  async getTokenPrice(address: string, currency = "usd", platform = "ethereum"): Promise<TokenPrice> {
    assert(this.priceFeeds.length > 0, "No price feeds are registered.");
    const priceCache: PriceCache = this.getPriceCache(currency, platform);
    const now: number = msToS(Date.now());

    let tokenPrice: TokenPrice | undefined = priceCache[address];
    const cacheMiss = tokenPrice === undefined || now - this.maxPriceAge > tokenPrice.timestamp;

    if (this.maxPriceAge > 0) {
      const age: number = tokenPrice ? now - tokenPrice.timestamp : Number.MAX_VALUE;
      this.logger.debug({
        at: "PriceClient#getTokenPrice",
        message: `Cache ${cacheMiss ? "miss" : "hit"} on ${platform}/${currency} for token ${address}.`,
        age: `${age} S`,
        price: tokenPrice,
      });
    }

    if (cacheMiss) {
      const prices: TokenPrice[] = await this.getTokenPrices([address], currency, platform);
      tokenPrice = prices[0];
    }
    return tokenPrice;
  }

  async getTokenPrices(addresses: string[], currency = "usd", platform = "ethereum"): Promise<TokenPrice[]> {
    assert(this.priceFeeds.length > 0, "No price feeds were registerted.");
    const priceCache: PriceCache = this.getPriceCache(currency, platform);

    // Pre-populate price cache with requested token addresses
    this.initPrices(priceCache, addresses);

    const prices: PriceCache = await this.requestPrices(addresses, currency, platform);
    if (Object.keys(prices).length === 0) {
      this.logger.warn({ at: "PriceClient#getTokenPrices", message: "Failed to update token prices." });
      // @todo throw ?
      return [];
    }

    this.updateCache(priceCache, prices, addresses);
    return addresses.map((addr: string) => priceCache[addr.toLowerCase()]);
  }

  expireCache(currency: string, platform = "ethereum"): void {
    const priceCache = this.getPriceCache(currency, platform);
    Object.values(priceCache).forEach((token: TokenPrice) => (token.timestamp = 0));
    this.logger.debug({ at: "PriceClient#expireCache", message: `Expired ${platform}/${currency} cache.` });
  }

  protected getPriceCache(currency: string, platform: string): PriceCache {
    if (this.prices[platform] === undefined) this.prices[platform] = {};
    if (this.prices[platform][currency] === undefined) this.prices[platform][currency] = {};
    return this.prices[platform][currency];
  }

  private initPrices(priceCache: PriceCache, addresses: string[]): void {
    addresses.forEach((addr: string) => {
      if (priceCache[addr] === undefined) {
        priceCache[addr] = { address: addr, price: 0, timestamp: 0 };
      }
    });
  }

  private async requestPrices(addresses: string[], currency: string, platform: string): Promise<PriceCache> {
    let prices: TokenPrice[] = [];

    for (const priceFeed of this.priceFeeds) {
      this.logger.debug({
        at: "PriceClient#getTokenPrice",
        message: `Looking up prices via ${priceFeed.name}.`,
      });
      try {
        prices = await priceFeed.getTokenPrices(addresses, currency, platform);
        if (prices.length === 0) {
          throw Error(`Zero-length response received from ${priceFeed.name}.`);
        }
      } catch (err) {
        this.logger.debug({
          at: "PriceClient#requestPrices",
          message: `Price lookup against ${priceFeed.name} failed (${err}).`,
        });
        continue; // Failover to the next price feed...
      }
    }

    if (prices.length === 0) {
      throw Error(`Price lookup failed against all price feeds (${this.listPriceFeeds().toString()}).`);
    }

    return Object.fromEntries(prices.map((price) => [price.address, price]));
  }

  private updateCache(priceCache: PriceCache, prices: PriceCache, expected: string[]): void {
    const updated: string[] = [];
    const skipped: { [token: string]: string } = {}; // Includes reason for skipping

    expected.forEach((addr: string) => {
      const tokenPrice: TokenPrice | undefined = prices[addr.toLowerCase()];
      const now: number = msToS(Date.now());

      if (tokenPrice === undefined) {
        skipped[addr] = "Not included in price feed response.";
      } else if (tokenPrice.timestamp > now) {
        skipped[addr] = `Token price timestamp is too new (timestamp ${tokenPrice.timestamp}).`;
      } else if (tokenPrice.timestamp >= priceCache[addr].timestamp) {
        // @todo: Do we care if the token price is older than maxPriceAge?
        priceCache[addr] = tokenPrice;
        updated.push(addr);
      } else if (tokenPrice.timestamp === priceCache[addr].timestamp) {
        this.logger.debug({
          at: "PriceClient#updateCache",
          message: `No new price available for token ${addr}.`,
          token: tokenPrice,
        });
      }
    });

    if (updated.length > 0) {
      this.logger.debug({
        at: "PriceClient#updateCache",
        message: "Updated token prices.",
        tokens: updated,
      });
    }

    if (Object.keys(skipped).length > 0) {
      this.logger.debug({
        at: "PriceClient#updateCache",
        message: "Some token prices were not updated.",
        tokens: skipped,
      });
    }
  }
}
