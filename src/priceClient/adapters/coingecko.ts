import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "./baseAdapter";

type CoinGeckoTokenPrice = {
  [currency: string]: number;
  last_updated_at: number;
};

type CoinGeckoPriceResponse = {
  [address: string]: CoinGeckoTokenPrice;
};

type CoinGeckoArgs = BaseHTTPAdapterArgs & {
  name?: string;
  apiKey?: string;
};

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  private readonly apiKey: string | undefined = undefined;

  constructor({ name, apiKey, timeout = 5000, retries = 3 }: CoinGeckoArgs = {}) {
    super(name ?? apiKey ? "CoinGecko Pro" : "CoinGecko Free", apiKey ? "pro-api.coingecko.com" : "api.coingecko.com", {
      timeout,
      retries,
    });
    this.apiKey = apiKey;
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const price = await this.getPricesByAddress([address], currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    const queryArgs: { [key: string]: boolean | string } = {
      contract_addresses: addresses.map((address) => address.toLowerCase()).join(","),
      vs_currencies: currency,
      include_last_updated_at: true,
    };
    if (this.apiKey) queryArgs["x_cg_pro_api_key"] = this.apiKey;

    const prices: unknown = await this.query("api/v3/simple/token_price/ethereum", queryArgs);
    if (!this.validateResponse(prices, currency))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(prices)}`);

    return addresses
      .filter((address) => prices[address.toLowerCase()] !== undefined)
      .map((address) => {
        const price: CoinGeckoTokenPrice = prices[address.toLowerCase()];
        return { address, price: price[currency], timestamp: price.last_updated_at };
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
