import assert from "assert";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "../../constants";
import { msToS, PriceFeedAdapter, TokenPrice } from "../priceClient";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "./baseAdapter";

// Binance quotes pairs (base/quote) rather than USD legs, so each supported token address maps
// either to a fixed USD anchor, or to a listed Binance pair whose top-of-book mid resolves the
// token price in terms of that anchor. `invert` is set when the token is on the quote side of
// the listing (i.e. the USD price is 1 / mid).
export type BinancePairMapping = { fixed: number } | { symbol: string; invert: boolean };

export type BinanceMappings = { [address: string]: BinancePairMapping };

type BinanceArgs = BaseHTTPAdapterArgs & {
  name?: string;
  host?: string;
  mappings?: BinanceMappings;
};

type BookTickerResponse = {
  symbol: string;
  bidPrice: string;
  askPrice: string;
};

// USDC anchors the USD leg: Binance lists USDCUSDT (USDT per 1 USDC) but no USD pair for either
// token, so USDC is pinned to 1.0 and USDT resolves to 1 / mid(USDCUSDT). This preserves the
// exact Binance USDT/USDC ratio, which is what stablecoin swap-fill profitability checks consume.
const DEFAULT_MAPPINGS: BinanceMappings = {
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: { fixed: 1.0 },
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: { symbol: "USDCUSDT", invert: true },
};

export class PriceFeed extends BaseHTTPAdapter implements PriceFeedAdapter {
  readonly mappings: BinanceMappings;

  constructor({
    name = "Binance",
    host = "data-api.binance.vision", // Public market-data mirror; api.binance.com is geo-restricted.
    timeout = 5000, // ms
    retries = 2,
    mappings = DEFAULT_MAPPINGS,
  }: BinanceArgs = {}) {
    super(name, host, { timeout, retries });
    this.mappings = Object.fromEntries(
      Object.entries(mappings).map(([address, mapping]) => [address.toLowerCase(), mapping])
    );
  }

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const [tokenPrice] = await this.getPricesByAddress([address], currency);
    assert(tokenPrice !== undefined, `${this.name} adapter has no mapping for token ${address}.`);
    return tokenPrice;
  }

  // Addresses without a mapping are omitted from the response. The PriceClient treats omitted
  // addresses as skipped and falls through to the next feed in its list, so this adapter can be
  // installed ahead of general-purpose USD feeds to pin specific tokens to Binance pricing.
  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    if (currency !== "usd") throw new Error(`Currency ${currency} not supported by ${this.name}`);

    const supported = addresses.filter((address) => this.mappings[address.toLowerCase()] !== undefined);
    const symbols = supported
      .map((address) => this.mappings[address.toLowerCase()])
      .filter((mapping): mapping is { symbol: string; invert: boolean } => "symbol" in mapping)
      .map(({ symbol }) => symbol);

    const mids: { [symbol: string]: number } = Object.fromEntries(
      await Promise.all([...new Set(symbols)].map(async (symbol) => [symbol, await this.pairMid(symbol)]))
    );

    const timestamp = msToS(Date.now());
    return supported.map((address) => {
      const mapping = this.mappings[address.toLowerCase()];
      let price: number;
      if ("fixed" in mapping) {
        price = mapping.fixed;
      } else {
        const mid = mids[mapping.symbol];
        assert(mid !== undefined, `${this.name} missing pair mid for ${mapping.symbol}.`);
        price = mapping.invert ? 1 / mid : mid;
      }
      return { address, price, timestamp };
    });
  }

  private async pairMid(symbol: string): Promise<number> {
    const response = await this.query("api/v3/ticker/bookTicker", { symbol });
    if (!this.validateResponse(response)) {
      throw new Error(`Unexpected ${this.name} response: ${JSON.stringify(response)}`);
    }

    const [bid, ask] = [Number(response.bidPrice), Number(response.askPrice)];
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
      throw new Error(
        `Invalid ${this.name} bookTicker for ${symbol} (bidPrice ${response.bidPrice}, askPrice ${response.askPrice})`
      );
    }

    return (bid + ask) / 2;
  }

  private validateResponse(response: unknown): response is BookTickerResponse {
    if (response === null || typeof response !== "object") return false;
    const { symbol, bidPrice, askPrice } = response as Record<string, unknown>;
    return typeof symbol === "string" && typeof bidPrice === "string" && typeof askPrice === "string";
  }
}
