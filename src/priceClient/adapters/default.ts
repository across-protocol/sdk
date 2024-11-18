import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter } from "./baseAdapter";

/**
 * Fallback price adapter to unconditionally return 0 on all input addresses.
 * This adapter can be used as a last-resort to default to a token price of 0
 * in case all other adapters fail to resolve a token price.
 *
 * Note: This adapter could be augmented to permit returning a custom price on a per-token bsis.
 * This would allow the caller to peg token prices, which has been a use cases in the Across API.
 * That's left as an open possibility for now.
 */
export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  constructor() {
    super("Zero Adapter", "127.0.0.1", {});
  }

  async getPriceByAddress(address: string, currency: string): Promise<TokenPrice> {
    const price = await this.getPricesByAddress([address], currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], _currency: string): Promise<TokenPrice[]> {
    return addresses.map((address) => ({ address, price: 0, timestamp: 0 }));
  }
}
