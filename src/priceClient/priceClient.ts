import assert from "assert";
import { CoinGeckoPrice } from "../coingecko";
import { Logger } from "../relayFeeCalculator"; // @todo: Relocate Logger to utils?

export { Logger } from "../relayFeeCalculator"; // Permit adapters to import a common definition.
export type TokenPrice = CoinGeckoPrice; // Temporary inversion; CoinGecko should source from here.

// Represents valid source for spot prices (Across API, CoinGecko, ...)
export interface PriceFeedAdapter {
  readonly name: string;
  getPriceByAddress(address: string, currency: string, platform: string): Promise<TokenPrice>;
  getPricesByAddress(addresses: string[], currency: string, platform: string): Promise<TokenPrice[]>;
}

export type PriceCache = {
  [address: string]: TokenPrice;
};

export function msToS(ms: number): number {
  return Math.floor(ms / 1000);
}

export class PriceClient implements PriceFeedAdapter {
  public readonly name: string = "PriceClient";
  private _maxPriceAge = 300; // seconds
  protected prices: {
    [platform: string]: {
      [currency: string]: PriceCache;
    };
  } = {};

  constructor(protected logger: Logger, readonly priceFeeds: PriceFeedAdapter[]) {
    assert(logger, "No logging instance supplied.");
    assert(priceFeeds.length > 0, "No price feeds supplied.");
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

  listPriceFeeds(): string[] {
    return this.priceFeeds.map((priceFeed: PriceFeedAdapter) => priceFeed.name);
  }

  async getPriceByAddress(address: string, currency = "usd", platform = "ethereum"): Promise<TokenPrice> {
    assert(this.priceFeeds.length > 0, "No price feeds are registered.");
    const priceCache: PriceCache = this.getPriceCache(currency, platform);
    const now: number = msToS(Date.now());

    let tokenPrice: TokenPrice | undefined = priceCache[address];
    const cacheMiss = tokenPrice === undefined || now - this.maxPriceAge > tokenPrice.timestamp;

    if (this.maxPriceAge > 0) {
      const age: number = tokenPrice ? now - tokenPrice.timestamp : Number.MAX_SAFE_INTEGER;
      this.logger.debug({
        at: "PriceClient#getPriceByAddress",
        message: `Cache ${cacheMiss ? "miss" : "hit"} on ${platform}/${currency} for token ${address}.`,
        age: `${age} S`,
        price: tokenPrice,
      });
    }

    if (cacheMiss) {
      const prices: TokenPrice[] = await this.getPricesByAddress([address], currency, platform);
      tokenPrice = prices[0];
    }
    return tokenPrice;
  }

  async getPricesByAddress(addresses: string[], currency = "usd", platform = "ethereum"): Promise<TokenPrice[]> {
    assert(this.priceFeeds.length > 0, "No price feeds were registerted.");
    const priceCache: PriceCache = this.getPriceCache(currency, platform);

    // Pre-populate price cache with requested token addresses
    this.initPrices(priceCache, addresses);

    const prices: PriceCache = await this.requestPrices(addresses, currency, platform);
    if (Object.keys(prices).length === 0) {
      this.logger.warn({ at: "PriceClient#getPricesByAddress", message: "Failed to update token prices." });
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
        at: "PriceClient#getPriceByAddress",
        message: `Looking up prices via ${priceFeed.name}.`,
      });
      try {
        prices = await priceFeed.getPricesByAddress(addresses, currency, platform);
        if (prices.length === 0) {
          throw Error(`Zero-length response received from ${priceFeed.name}`);
        }
      } catch (err) {
        this.logger.debug({
          at: "PriceClient#requestPrices",
          message: `Price lookup against ${priceFeed.name} failed (${err}).`,
          tokens: addresses,
        });
        continue; // Failover to the next price feed...
      }
    }

    if (prices.length === 0) {
      throw Error(`Price lookup failed against all price feeds (${this.listPriceFeeds().toString()})`);
    }

    return Object.fromEntries(prices.map((price) => [price.address, price]));
  }

  private updateCache(priceCache: PriceCache, prices: PriceCache, expected: string[]): void {
    const updated: TokenPrice[] = [];
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
        updated.push(tokenPrice);
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
        message: `Updated ${updated.length} token price(s), skipped ${skipped.length ?? 0}.`,
        tokensUpdated: updated,
        tokensSkipped: skipped,
      });
    }
  }
}
