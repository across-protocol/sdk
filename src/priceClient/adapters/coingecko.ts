import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter } from "./baseAdapter";

type CoinGeckoTokenPrice = {
  [currency: string]: number;
  last_updated_at: number;
};

type CoinGeckoPriceResponse = {
  [address: string]: CoinGeckoTokenPrice;
};

const defaultTimeout = 5000; // mS

type CoinGeckoArgs = {
  name?: string;
  timeout?: number;
  apiKey?: string;
};

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  private readonly apiKey: string | undefined = undefined;

  constructor(args: CoinGeckoArgs = {}) {
    super(
      args?.name ?? args?.apiKey ? "CoinGecko Pro" : "CoinGecko Free",
      args?.apiKey ? "pro-api.coingecko.com" : "api.coingecko.com",
      { timeout: args?.timeout ?? defaultTimeout }
    );
    this.apiKey = args?.apiKey;
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const price = await this.getPricesByAddress([address], currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    const queryArgs: { [key: string]: boolean | string } = {
      contract_addresses: addresses.join(","),
      vs_currencies: currency,
      include_last_updated_at: true,
    };
    if (this.apiKey) queryArgs["x_cg_pro_api_key"] = this.apiKey;

    const prices: unknown = await this.query("api/v3/simple/token_price/ethereum", queryArgs);
    if (!this.validateResponse(prices, currency))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(prices)}`);

    return addresses.map((addr: string) => {
      const price: CoinGeckoTokenPrice = prices[addr.toLowerCase()];
      if (price === undefined) throw new Error(`Token ${addr} missing from ${this.name} response`);

      return { address: addr, price: price[currency], timestamp: price.last_updated_at };
    });
  }

  private validateResponse(response: unknown, currency: string): response is CoinGeckoPriceResponse {
    if (typeof response !== "object") return false;

    return Object.entries(response as object).every(([address, tokenPrice]) => {
      // prettier-ignore
      return (
        /0x[0-9a-fA-F]{40}/.exec(address) !== undefined
        && typeof tokenPrice === "object"
        && !isNaN(tokenPrice[currency])
        && !isNaN(tokenPrice.last_updated_at)
      );
    });
  }
}
