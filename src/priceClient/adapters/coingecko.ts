import assert from "assert";
import axios, { AxiosError } from "axios";
import { PriceFeedAdapter, TokenPrice } from "../priceClient";

type CoinGeckoTokenPrice = {
  [currency: string]: number;
  last_updated_at: number;
};

type CoinGeckoPriceResponse = {
  [address: string]: CoinGeckoTokenPrice;
};

const defaultTimeout = 5000; // mS

export class PriceFeed implements PriceFeedAdapter {
  public readonly host: string;
  protected _timeout = defaultTimeout;

  constructor(public readonly name: string, private readonly apiKey?: string) {
    this.host = this.apiKey ? "pro-api.coingecko.com" : "api.coingecko.com";
  }

  get timeout(): number {
    return this._timeout;
  }

  set timeout(timeout: number) {
    assert(timeout >= 0);
    this._timeout = timeout;
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const price: TokenPrice[] = await this.getPricesByAddress([address], currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    const prices: CoinGeckoPriceResponse = await this.query(addresses, currency);
    return addresses.map((addr: string) => {
      const price: CoinGeckoTokenPrice = prices[addr.toLowerCase()];
      return { address: addr, price: price[currency], timestamp: price.last_updated_at };
    });
  }

  private async query(
    addresses: string[],
    baseCurrency = "usd",
    timeout: number = defaultTimeout
  ): Promise<CoinGeckoPriceResponse> {
    const url = `https://${this.host}/api/v3/simple/token_price/ethereum`;
    const args = {
      timeout,
      params: {
        contract_addresses: addresses.join(","),
        vs_currencies: baseCurrency,
        include_last_updated_at: true,
        x_cg_pro_api_key: this.apiKey ?? "",
      },
    };

    const result = await axios(url, args).catch((err) => {
      const errMsg: string = err instanceof AxiosError ? err.message : "unknown error";
      throw new Error(`${this.name} price lookup failure (${errMsg})`);
    });
    return result.data;
  }
}
