import { msToS, PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter } from "./baseAdapter";

type AcrossPrice = { price: number };
const defaultTimeout = 5000; // mS

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  constructor(name: string, { host, timeout }: { host?: string; timeout?: number }) {
    // Allow host to be overridden for test or alternative deployments.
    super(name, host ?? "across.to", { timeout: timeout ?? defaultTimeout });
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const queryArgs = {
      l1Token: address,
      baseCurrency: currency,
    };

    const now = msToS(Date.now()) - 60; // Assume price is 60 seconds old.
    const response: unknown = await this.query("api/coingecko", queryArgs);
    if (!this.validateResponse(response))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(response)}`);

    return { address: address, price: response.price, timestamp: now };
  }

  // todo: Support bundled prices in the API endpoint.
  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    return Promise.all(addresses.map((address) => this.getPriceByAddress(address, currency)));
  }

  private validateResponse(response: unknown): response is AcrossPrice {
    if (typeof response !== "object") return false;
    return response !== null && typeof (response as { [key: string]: unknown }).price === "number";
  }
}
