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
    const response: unknown = await this.query(path, {});
    if (!this.validateResponse(response))
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(response)}`);

    // Normalise the address format: "etherum:"<address> => <address>.
    const tokenPrices: { [address: string]: DefiLlamaTokenPrice } = Object.fromEntries(
      Object.entries(response.coins).map(([identifier, tokenPrice]) => [identifier.split(":")[1], tokenPrice])
    );

    return Object.entries(tokenPrices)
      .filter(([address, tokenPrice]) => {
        return addresses.includes(address) && tokenPrice.confidence >= this.minConfidence;
      })
      .map(([address, tokenPrice]) => {
        const { price, timestamp } = tokenPrice;
        return { address, price, timestamp } as TokenPrice;
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
