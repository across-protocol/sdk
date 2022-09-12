import axios, { AxiosError } from "axios";
import get from "lodash.get";
import { Logger, msToS, PriceFeedAdapter, TokenPrice } from "../priceClient";

type AcrossPrice = { price: number };

export class PriceFeed implements PriceFeedAdapter {
  public readonly platforms = ["ethereum"];

  constructor(public readonly logger: Logger, public readonly name: string, public readonly host?: string) {
    // Allow host to be overridden for test or alternative deployments.
    if (this.host === undefined) this.host = "across.to";
  }

  async getTokenPrice(address: string, currency: string, platform: string): Promise<TokenPrice> {
    if (!this.platforms.includes(platform)) throw Error(`Platform ${platform} not supported.`);

    // Note: Assume price is 60 seconds old since the API does not provide a timestamp.
    const now = msToS(Date.now()) - 60;
    const acrossPrice: AcrossPrice = await this.query(address, currency);

    return { address: address, price: acrossPrice.price, timestamp: now };
  }

  // todo: Support bundled prices in the API endpoint.
  async getTokenPrices(addresses: string[], currency: string, platform: string): Promise<TokenPrice[]> {
    if (!this.platforms.includes(platform)) throw Error(`Platform ${platform} not supported.`);

    const prices: TokenPrice[] = [];
    for (const address of addresses) {
      const price: TokenPrice = await this.getTokenPrice(address, currency, platform);
      prices.push(price);
    }

    return prices;
  }

  private async query(token: string, baseCurrency: string, timeout?: number): Promise<AcrossPrice> {
    const url = `https://${this.host}/api/coingecko?l1Token=${token}&baseCurrency=${baseCurrency}`;

    try {
      this.logger.debug({ at: "Across#query", message: "Querying api/coingecko.", query: url });
      const result = await axios(url, { timeout });
      return result.data;
    } catch (err) {
      const msg = get(err, "response.data.error", get(err, "response.statusText", (err as AxiosError).message));
      throw Error(msg);
    }
  }
}
