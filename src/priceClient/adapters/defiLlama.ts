import assert from "assert";
import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "./baseAdapter";

type DefiLlamaTokenPrice = {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
};

type DefiLlamaPriceResponse = {
  coins: {
    [key: string]: DefiLlamaTokenPrice;
  };
};

type DefiLlamaArgs = BaseHTTPAdapterArgs & {
  name?: string;
  host?: string;
  minConfidence?: number;
};

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  private _minConfidence: number;

  constructor({
    name = "DefiLlama",
    host = "coins.llama.fi",
    timeout = 5000,
    retries = 2,
    minConfidence = 0.9,
  }: DefiLlamaArgs = {}) {
    super(name, host, { timeout, retries });
    assert(minConfidence >= 0.0 && minConfidence <= 1.0);
    this._minConfidence = minConfidence;
  }

  get minConfidence(): number {
    return this._minConfidence;
  }

  set minConfidence(minConfidence: number) {
    assert(minConfidence >= 0.0 && minConfidence <= 1.0);
    this._minConfidence = minConfidence;
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const price = await this.getPricesByAddress([address], currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    if (currency != "usd") throw new Error(`Currency ${currency} not supported by ${this.name}`);

    const path = "prices/current/" + addresses.map((address) => `ethereum:${address.toLowerCase()}`).join();
    const response: unknown = await this.query(path, {});
    if (!this.validateResponse(response))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(response)}`);

    // Normalise the address format: "etherum:<address>" => "<address>".
    const tokenPrices: { [address: string]: DefiLlamaTokenPrice } = Object.fromEntries(
      Object.entries(response.coins).map(([identifier, tokenPrice]) => [identifier.split(":")[1], tokenPrice])
    );

    return addresses
      .filter((address) => {
        return (tokenPrices[address.toLowerCase()]?.confidence || 0.0) >= this.minConfidence;
      })
      .map((address) => {
        const { price, timestamp } = tokenPrices[address.toLowerCase()];
        return { address, price, timestamp };
      });
  }

  private validateResponse(response: unknown): response is DefiLlamaPriceResponse {
    if (response === null || typeof response !== "object") return false;

    const coins: unknown = (response as Record<string, unknown>).coins;
    if (coins === null || typeof coins !== "object") return false;

    return Object.entries(coins as object).every(([address, tokenPrice]) => {
      // prettier-ignore
      return (
        /[a-z]+:0[xX][0-9a-fA-F]{40}/.exec(address) !== undefined
        && typeof tokenPrice === "object"
        && typeof tokenPrice.symbol === "string"
        && !isNaN(tokenPrice.decimals)
        && (tokenPrice.decimals > 0 && tokenPrice.decimals <= 18)
        && !isNaN(tokenPrice.price)
        && !isNaN(tokenPrice.timestamp)
        && !isNaN(tokenPrice.confidence)
      );
    });
  }
}
