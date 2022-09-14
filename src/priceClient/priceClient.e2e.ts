import assert from "assert";
import dotenv from "dotenv";
import winston from "winston";
import { Logger, msToS, PriceCache, PriceClient, PriceFeedAdapter, TokenPrice } from "./priceClient";
import { across, coingecko } from "./adapters";
dotenv.config({ path: ".env" });

const maxPriceAge = 300;

class TestPriceClient extends PriceClient {
  constructor(logger: Logger, priceFeeds: PriceFeedAdapter[]) {
    super(logger, priceFeeds);
  }

  getProtectedPriceCache(currency: string, platform: string): PriceCache {
    return this.getPriceCache(currency, platform);
  }
}

function validateTokenPrice(tokenPrice: TokenPrice, address: string, timestamp: number) {
  assert.ok(tokenPrice);
  assert(tokenPrice.address === address);
  assert(tokenPrice.price > 0);
  assert(tokenPrice.timestamp > 0);
  assert(
    tokenPrice.timestamp > timestamp - maxPriceAge,
    `Surprise timestamp received: ${tokenPrice.timestamp} (expected at least ${timestamp - maxPriceAge}).`
  );
}

// this requires e2e testing, should only test manually for now
describe("PriceClient", function () {
  const dummyLogger: winston.Logger = winston.createLogger({
    level: "debug",
    transports: [new winston.transports.Console()],
  });

  const addresses: { [symbol: string]: string } = {
    // lower-case
    UMA: "0x04fa0d235c4abf4bcf4787af4cf447de572ef828",
  };

  const testAddress = addresses["UMA"];
  const baseCurrency = "usd";
  const platform = "ethereum";

  let pc: PriceClient;
  let beginTs: number;

  beforeEach(() => {
    beginTs = msToS(Date.now());
  });

  test("Price feed ordering", async function () {
    // Generate a list with ~random names; nb. names are not (currently?) required to be unique.
    const feedNames = Array(3)
      .fill("Test PriceFeed")
      .map((name) => {
        return `${name}-${Math.trunc(Math.random() * 100) + 1}`;
      });

    pc = new PriceClient(
      dummyLogger,
      feedNames.map((feedName) => new across.PriceFeed(feedName))
    );
    expect(feedNames).toEqual(pc.listPriceFeeds());
  });

  test("getPriceByAddress: CoinGecko Free", async function () {
    pc = new PriceClient(dummyLogger, [new coingecko.PriceFeed("CoinGecko Free", dummyLogger)]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  // Only attempt to test CG Pro if the environment defines COINGECKO_PRO_API_KEY
  const cgProApiKey = process.env.COINGECKO_PRO_API_KEY;
  const cgProTest = typeof cgProApiKey === "string" && cgProApiKey.length > 0 ? test : test.skip;
  cgProTest("getPriceByAddress: CoinGecko Pro", async function () {
    pc = new PriceClient(dummyLogger, [new coingecko.PriceFeed("CoinGecko Pro", dummyLogger, cgProApiKey)]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Across API", async function () {
    pc = new PriceClient(dummyLogger, [new across.PriceFeed("Across API")]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Across failover to Across", async function () {
    pc = new PriceClient(dummyLogger, [
      new across.PriceFeed("Across API (expect fail)", "127.0.0.1"),
      new across.PriceFeed("Across API (expect pass)"),
    ]);

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Across failover to CoinGecko", async function () {
    pc = new PriceClient(dummyLogger, [
      new across.PriceFeed("Across API (expect fail)", "127.0.0.1"),
      new coingecko.PriceFeed("CoinGecko Free (expect pass)", dummyLogger),
    ]);

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Complete price lookup failure", async function () {
    pc = new PriceClient(dummyLogger, [
      new across.PriceFeed("Across API #1 (expect fail)", "127.0.0.1"),
      new across.PriceFeed("Across API #2 (expect fail)", "127.0.0.1"),
    ]);
    await expect(pc.getPriceByAddress(testAddress)).rejects.toThrow();
  });

  test("getPriceByAddress: Across API timeout", async function () {
    const acrossPriceFeed: across.PriceFeed = new across.PriceFeed("Across API (timeout)");
    pc = new PriceClient(dummyLogger, [acrossPriceFeed]);

    acrossPriceFeed.timeout = 1; // mS
    await expect(pc.getPriceByAddress(testAddress)).rejects.toThrow();

    acrossPriceFeed.timeout = 1000; // mS
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("Validate price cache", async function () {
    // Instantiate a custom subclass of PriceClient; load the cache and force price lookup failures.
    const pc: TestPriceClient = new TestPriceClient(dummyLogger, [
      new across.PriceFeed("Across API (expect fail)", "127.0.0.1"),
    ]);

    const priceCache: PriceCache = pc.getProtectedPriceCache(baseCurrency, platform);
    pc.maxPriceAge = 600; // Bound timestamps by 10 minutes

    for (let i = 0; i < 10; ++i) {
      const addr = `0x${i.toString(16).padStart(42, "0")}`; // Non-existent
      priceCache[addr] = {
        address: addr,
        price: Math.random() * (1 + i),
        timestamp: msToS(Date.now()) - pc.maxPriceAge + (1 + i),
      };
    }

    // Verify cache hit for valid timestamps.
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      const token: TokenPrice = await pc.getPriceByAddress(addr, baseCurrency);

      assert.ok(token.timestamp === expected.timestamp, `${expected.timestamp} !== ${token.timestamp}`);
      assert.ok(token.price === expected.price, `${expected.price} !== ${token.price}`);
    }

    // Invalidate all cached results and verify failed price lookup.
    pc.maxPriceAge = 1; // seconds
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      await expect(pc.getPriceByAddress(addr, baseCurrency)).rejects.toThrow();
    }
  });
});
