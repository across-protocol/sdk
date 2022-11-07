import assert from "assert";
import { PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter } from "./baseAdapter";

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

type DefiLlamaArgs = {
  name?: string;
  host?: string;
  timeout?: number;
  minConfidence?: number;
};

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  private _minConfidence: number;

  constructor({
    name = "DefiLlama",
    host = "coins.llama.fi",
    timeout = 5000,
    minConfidence = 0.9,
  }: DefiLlamaArgs = {}) {
    super(name, host, { timeout });
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

    const path = "prices/current/" + addresses.map((address) => `ethereum:${address}`).join();
    const tokenPrices: unknown = await this.query(path, {});
    if (!this.validateResponse(tokenPrices))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(tokenPrices)}`);

    return addresses.map((address: string) => {
      const tokenPrice = tokenPrices.coins[`ethereum:${address}`];
      if (tokenPrice === undefined) throw new Error(`Token ${address} missing from ${this.name} response`);

      if (tokenPrice.confidence < this.minConfidence)
        throw new Error(`Token ${address} has low confidence score (${tokenPrice.confidence})`);

      return { address, price: tokenPrice.price, timestamp: tokenPrice.timestamp };
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
