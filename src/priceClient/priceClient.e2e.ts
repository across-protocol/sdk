import assert from "assert";
import dotenv from "dotenv";
import winston from "winston";
import { Logger, msToS, PriceCache, PriceClient, TokenPrice } from "./priceClient";
import { across, coingecko } from "./adapters";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const maxPriceAge = 300;

class TestPriceClient extends PriceClient {
  private static testInstance: TestPriceClient | undefined;

  public static get(logger: Logger) {
    if (!this.testInstance) this.testInstance = new TestPriceClient(logger);
    return this.testInstance;
  }

  // Hack to return protected getPriceCache.
  _getPriceCache(currency: string, platform: string): PriceCache {
    return this.getPriceCache(currency, platform);
  }

  protected constructor(logger: Logger) {
    super(logger);
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
  const addresses: { [symbol: string]: string } = {
    // lower-case
    UMA: "0x04fa0d235c4abf4bcf4787af4cf447de572ef828",
  };

  // Only attempt to test CG Pro if the environment defines COINGECKO_PRO_API_KEY
  const cgProApiKey = process.env.COINGECKO_PRO_API_KEY;
  const cgProTest = typeof cgProApiKey === "string" && cgProApiKey.length > 0 ? test : test.skip;

  const testAddress = addresses["UMA"];
  const baseCurrency = "usd";
  const platform = "ethereum";

  let pc: PriceClient;
  let beginTs: number;

  beforeEach(async () => {
    pc = PriceClient.get(dummyLogger);
    assert.ok(pc);

    // Remove any previously added price feeds.
    pc.clearPriceFeeds();
    expect(pc.listPriceFeeds().length).toEqual(0);

    pc.expireCache(baseCurrency, platform);
    beginTs = msToS(Date.now());
  });

  test("Price feed ordering", async function () {
    // Generate a list with ~random names; nb. names are not (currently?) required to be unique.
    const feedNames = Array(3)
      .fill("Test PriceFeed")
      .map((name) => {
        return `${name}-${Math.trunc(Math.random() * 100) + 1}`;
      });
    feedNames.forEach((name) => pc.addPriceFeed(new across.PriceFeed(dummyLogger, name)));
    expect(feedNames).toEqual(pc.listPriceFeeds());
  });
  test("getPriceByAddress: CoinGecko Free", async function () {
    pc.addPriceFeed(new coingecko.PriceFeed(dummyLogger, "CoinGecko Free"));
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });
  cgProTest("getPriceByAddress: CoinGecko Pro", async function () {
    pc.addPriceFeed(new coingecko.PriceFeed(dummyLogger, "CoinGecko Pro", cgProApiKey));
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });
  test("getPriceByAddress: Across API", async function () {
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API"));
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });
  test("getPriceByAddress: Across failover to Across", async function () {
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API (expect fail)", "127.0.0.1"));
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API (expect pass)"));

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });
  test("getPriceByAddress: Across failover to CoinGecko", async function () {
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API (expect fail)", "127.0.0.1"));
    pc.addPriceFeed(new coingecko.PriceFeed(dummyLogger, "CoinGecko Free (expect pass)"));

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });
  test("getPriceByAddress: Complete price lookup failure", async function () {
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API #1 (expect fail)", "127.0.0.1"));
    pc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API #2 (expect fail)", "127.0.0.1"));
    await expect(pc.getPriceByAddress(addresses["UMA"])).rejects.toThrow();
  });

  test("Validate price cache", async function () {
    // Don't lookup against CoinGecko.
    const tc: TestPriceClient = TestPriceClient.get(dummyLogger);
    assert.ok(tc);

    const priceCache: PriceCache = tc._getPriceCache(baseCurrency, platform);
    tc.maxPriceAge = 600; // Bound timestamps by 10 minutes
    tc.addPriceFeed(new across.PriceFeed(dummyLogger, "Across API (expect fail)", "127.0.0.1"));

    for (let i = 0; i < 10; ++i) {
      const addr = `0x${i.toString(16).padStart(42, "0")}`; // Non-existent
      priceCache[addr] = {
        address: addr,
        price: Math.random() * (1 + i),
        timestamp: msToS(Date.now()) - tc.maxPriceAge + (1 + i),
      };
    }

    // Verify cache hit for valid timestamps.
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      const token: TokenPrice = await tc.getPriceByAddress(addr, baseCurrency);

      assert.ok(token.timestamp === expected.timestamp, `${expected.timestamp} !== ${token.timestamp}`);
      assert.ok(token.price === expected.price, `${expected.price} !== ${token.price}`);
    }

    // Invalidate all cached results and verify failed price lookup.
    tc.maxPriceAge = 1; // seconds
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      await expect(tc.getPriceByAddress(addr, baseCurrency)).rejects.toThrow();
    }
  });
});
