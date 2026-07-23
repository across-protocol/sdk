import winston from "winston";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "../src/constants";
import { Logger, PriceClient, PriceFeedAdapter, TokenPrice, msToS } from "../src/priceClient/priceClient";
import { binance } from "../src/priceClient/adapters";
import { expect } from "./utils";

const dummyLogger: Logger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const USDC = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
const USDT = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET];
const UNMAPPED = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class MockBinancePriceFeed extends binance.PriceFeed {
  public requestLog: { path: string; symbol: unknown }[] = [];
  public response: unknown = { symbol: "USDCUSDT", bidPrice: "1.0003", askPrice: "1.0005" };

  protected override query(path: string, urlArgs?: Record<string, unknown>): Promise<unknown> {
    this.requestLog.push({ path, symbol: urlArgs?.symbol });
    return Promise.resolve(this.response);
  }
}

describe("Binance PriceFeed adapter", function () {
  let feed: MockBinancePriceFeed;

  beforeEach(function () {
    feed = new MockBinancePriceFeed();
  });

  it("prices USDT via the inverted USDCUSDT mid and anchors USDC at 1.0", async function () {
    const before = msToS(Date.now());
    const prices = await feed.getPricesByAddress([USDC, USDT]);

    expect(feed.requestLog.length).to.equal(1);
    expect(feed.requestLog[0]).to.deep.equal({ path: "api/v3/ticker/bookTicker", symbol: "USDCUSDT" });

    const usdc = prices.find(({ address }) => address === USDC);
    const usdt = prices.find(({ address }) => address === USDT);
    expect(usdc?.price).to.equal(1.0);
    expect(usdt?.price).to.equal(1 / 1.0004); // mid of 1.0003/1.0005, inverted.
    prices.forEach(({ timestamp }) => expect(timestamp).to.be.at.least(before));
  });

  it("makes no HTTP request when only fixed-price tokens are requested", async function () {
    const [usdc] = await feed.getPricesByAddress([USDC]);
    expect(usdc.price).to.equal(1.0);
    expect(feed.requestLog.length).to.equal(0);
  });

  it("resolves addresses case-insensitively", async function () {
    const address = USDT.toUpperCase().replace("0X", "0x");
    const [usdt] = await feed.getPricesByAddress([address]);
    expect(usdt.address).to.equal(address);
    expect(usdt.price).to.equal(1 / 1.0004);
  });

  it("omits unmapped addresses from the response", async function () {
    const prices = await feed.getPricesByAddress([UNMAPPED, USDT]);
    expect(prices.length).to.equal(1);
    expect(prices[0].address).to.equal(USDT);
  });

  it("throws on getPriceByAddress for an unmapped address", async function () {
    await expect(feed.getPriceByAddress(UNMAPPED)).to.be.rejectedWith(/no mapping/);
  });

  it("rejects non-usd currencies", async function () {
    await expect(feed.getPricesByAddress([USDT], "eur")).to.be.rejectedWith(/not supported/);
  });

  it("throws on a malformed bookTicker response", async function () {
    feed.response = { symbol: "USDCUSDT", bidPrice: 1.0003 }; // askPrice missing, bidPrice not a string.
    await expect(feed.getPricesByAddress([USDT])).to.be.rejectedWith(/Unexpected Binance response/);
  });

  it("throws on a non-positive bookTicker price", async function () {
    feed.response = { symbol: "USDCUSDT", bidPrice: "0", askPrice: "1.0005" };
    await expect(feed.getPricesByAddress([USDT])).to.be.rejectedWith(/Invalid Binance bookTicker/);
  });

  it("supports custom pair mappings", async function () {
    const custom = new MockBinancePriceFeed({
      mappings: { [UNMAPPED]: { symbol: "USDCUSDT", invert: false } },
    });
    const [price] = await custom.getPricesByAddress([UNMAPPED]);
    expect(price.price).to.equal(1.0004);
  });

  it("falls through to the next PriceClient feed for unmapped tokens", async function () {
    const fallbackPrice: TokenPrice = { address: UNMAPPED, price: 42, timestamp: msToS(Date.now()) };
    const fallback: PriceFeedAdapter = {
      name: "fallback",
      getPriceByAddress: () => Promise.resolve(fallbackPrice),
      getPricesByAddress: () => Promise.resolve([fallbackPrice]),
    };
    const pc = new PriceClient(dummyLogger, [feed, fallback], true);

    const prices = await pc.getPricesByAddress([USDT, UNMAPPED]);
    expect(prices.find(({ address }) => address === USDT)?.price).to.equal(1 / 1.0004);
    expect(prices.find(({ address }) => address === UNMAPPED)?.price).to.equal(42);
  });
});
