import assert from "assert";
import axios, { AxiosError } from "axios";
import { msToS, PriceFeedAdapter, TokenPrice } from "../priceClient";

type AcrossPrice = { price: number };
const defaultTimeout = 5000; // mS

export class PriceFeed implements PriceFeedAdapter {
  protected _timeout = defaultTimeout;

  constructor(public readonly name: string, public readonly host?: string) {
    // Allow host to be overridden for test or alternative deployments.
    if (this.host === undefined) this.host = "across.to";
  }

  get timeout(): number {
    return this._timeout;
  }

  set timeout(timeout: number) {
    assert(timeout >= 0);
    this._timeout = timeout;
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    // Note: Assume price is 60 seconds old since the API does not provide a timestamp.
    const now = msToS(Date.now()) - 60;
    const acrossPrice: AcrossPrice = await this.query(address, currency, this._timeout);

    return { address: address, price: acrossPrice.price, timestamp: now };
  }

  // todo: Support bundled prices in the API endpoint.
  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    return Promise.all(addresses.map((address) => this.getPriceByAddress(address, currency)));
  }

  private async query(token: string, baseCurrency = "usd", timeout: number = defaultTimeout): Promise<AcrossPrice> {
    const url = `https://${this.host}/api/coingecko`;
    const args = {
      timeout,
      params: {
        l1Token: token,
        baseCurrency: baseCurrency,
      },
    };

    const result = await axios(url, args).catch((err) => {
      const errMsg: string = err instanceof AxiosError ? err.message : "unknown error";
      throw new Error(`${this.name} price lookup failure (${errMsg})`);
    });
    return result.data;
  }
}
