import assert from "assert";
import { CoinGeckoPrice } from "../coingecko";
import { Logger } from "../relayFeeCalculator"; // @todo: Relocate Logger to utils?

export { Logger }; // Permit adapters to import a common definition.
export type TokenPrice = CoinGeckoPrice; // Temporary inversion; CoinGecko should source from here.

// Represents valid source for spot prices (Across API, CoinGecko, ...)
export interface PriceFeedAdapter {
  readonly name: string;
  getPriceByAddress(address: string, currency: string): Promise<TokenPrice>;
  getPricesByAddress(addresses: string[], currency: string): Promise<TokenPrice[]>;
}

// It's convenient to map TokenPrice objects by their address, but consumers typically want an array
// of TokenPrice objects, so the address must also be embedded within the TokenPrice object. To
// avoid storing multiple copies of the same TokenPrice, always use the lower-case variant of the
// address when performing a lookup into the PriceCache, and substitute the provided address into the
// TokenPrice object when returning to the caller.
export type PriceCache = {
  [address: string]: TokenPrice;
};

export function msToS(ms: number): number {
  return Math.floor(ms / 1000);
}

// PriceClient aggregates various user-configured price feeds/sources and retains them for a
// configurable time period. External price lookups are performed according to an ordered list that
// is supplied during instantiation. The PriceClient will iterate over the list until a complete set
// of prices has been retrieved from a single source. External price lookups will opportunistically
// request new prices for _all_ previously requested tokens. Price lookups into PriceClient will be
// served out of its local cache if the token price is less than maxPriceAge seconds. This helps to
// suppress external price lookups and can help to mitigate rate-limiting by external providers.
// See README.md for further information and usage guidelines.
export class PriceClient implements PriceFeedAdapter {
  public readonly name: string = "PriceClient";
  private _maxPriceAge = 300; // seconds
  protected prices: {
    [currency: string]: PriceCache;
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

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const tokenPrices = await this.getPricesByAddress([address], currency);
    return tokenPrices[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    assert(this.priceFeeds.length > 0, "No price feeds are registered.");
    const priceCache = this.getPriceCache(currency);

    // Determine whether each *requested* price is current.
    const now = msToS(Date.now());
    const missed: { [address: string]: number } = {};
    addresses.forEach((address: string) => {
      const addr = address.toLowerCase();
      const tokenPrice = priceCache[addr] ?? ({ price: 0, timestamp: 0 } as TokenPrice);
      priceCache[addr] = tokenPrice; // Update priceCache if necessary;

      const age = now - tokenPrice.timestamp;
      if (age > this.maxPriceAge) {
        missed[address] = age;
      }
    });

    if (Object.keys(missed).length > 0) {
      const requestAddresses = Object.keys(priceCache);
      this.logger.debug({
        at: "PriceClient#getPricesByAddress",
        message: `${currency.toUpperCase()} cache miss (age > ${this.maxPriceAge} S).`,
        tokens: missed,
      });
      const prices = await this.requestPrices(requestAddresses, currency);
      this.updateCache(priceCache, prices, requestAddresses);
    }

    return addresses.map((addr: string) => {
      const { price, timestamp } = priceCache[addr.toLowerCase()];
      return { address: addr, price, timestamp };
    });
  }

  expireCache(currency: string): void {
    const priceCache = this.getPriceCache(currency);
    Object.values(priceCache).forEach((token: TokenPrice) => (token.timestamp = 0));
    this.logger.debug({ at: "PriceClient#expireCache", message: `Expired ${currency} cache.` });
  }

  protected getPriceCache(currency: string): PriceCache {
    if (this.prices[currency] === undefined) this.prices[currency] = {};
    return this.prices[currency];
  }

  private async requestPrices(addresses: string[], currency: string): Promise<PriceCache> {
    let prices: TokenPrice[] = [];

    for (const priceFeed of this.priceFeeds) {
      this.logger.debug({
        at: "PriceClient#getPriceByAddress",
        message: `Looking up prices via ${priceFeed.name}.`,
      });
      try {
        prices = await priceFeed.getPricesByAddress(addresses, currency);
        if (prices.length === 0) throw Error("Zero-length response received");
        // @todo: Handle partial price retrievals.
        else if (prices.length === addresses.length) break;
      } catch (err) {
        this.logger.debug({
          at: "PriceClient#requestPrices",
          message: `Price lookup against ${priceFeed.name} failed (${err}).`,
          tokens: addresses,
        });
        // Failover to the next price feed...
      }
    }

    if (prices.length === 0) {
      throw Error(`Price lookup failed against all price feeds (${this.listPriceFeeds().toString()})`);
    }

    return Object.fromEntries(prices.map((price) => [price.address.toLowerCase(), price]));
  }

  private updateCache(priceCache: PriceCache, prices: PriceCache, expected: string[]): void {
    const updated: TokenPrice[] = [];
    const skipped: { [token: string]: string } = {}; // Includes reason for skipping
    const now = msToS(Date.now());

    expected.forEach((address: string) => {
      const addr = address.toLowerCase(); // for internal priceCache lookup.
      const tokenPrice: TokenPrice | undefined = prices[addr];

      if (tokenPrice === undefined) {
        skipped[address] = "Not included in price feed response.";
      } else if (tokenPrice.timestamp > now) {
        skipped[address] = `Token price timestamp is too new (timestamp ${tokenPrice.timestamp}).`;
      } else if (tokenPrice.timestamp >= priceCache[addr].timestamp) {
        const { price, timestamp } = tokenPrice;
        // Drop the address; we sub it in when returning to the caller.
        // @todo: Do we care if the token price is older than maxPriceAge?
        priceCache[addr] = { price, timestamp } as TokenPrice;
        updated.push(tokenPrice);
      } else if (tokenPrice.timestamp === priceCache[addr].timestamp) {
        this.logger.debug({
          at: "PriceClient#updateCache",
          message: `No new price available for token ${address}.`,
          token: tokenPrice,
        });
      }
    });

    this.logger.debug({
      at: "PriceClient#updateCache",
      message: `Updated ${updated.length ?? 0} price(s), skipped ${Object.keys(skipped).length ?? 0}.`,
      updated,
      skipped,
    });
  }
}
