import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter } from "./baseAdapter";

type DefaultPrice = { [currency: string]: { [address: string]: number } };

/**
 * Fallback price adapter to unconditionally return 0 on all input addresses.
 * This adapter can be used as a last-resort to default to a token price of 0
 * in case all other adapters fail to resolve a token price.
 */
export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  constructor(private readonly prices: DefaultPrice = {}) {
    super("Default Adapter", "127.0.0.1", {});
  }

  async getPriceByAddress(address: string, currency: string): Promise<TokenPrice> {
    const [price] = await this.getPricesByAddress([address], currency);
    return price;
  }

  getPricesByAddress(addresses: string[], currency: string): Promise<TokenPrice[]> {
    return Promise.resolve(
      addresses.map((address) => {
        return {
          address,
          price: this.prices[currency]?.[address] ?? 0,
          timestamp: 0,
        };
      })
    );
  }
}
