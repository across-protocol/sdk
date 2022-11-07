import assert from "assert";
import dotenv from "dotenv";
import winston from "winston";
import { Logger, msToS, PriceCache, PriceClient, PriceFeedAdapter, TokenPrice } from "./priceClient";
import { acrossApi, coingecko, defiLlama } from "./adapters";

dotenv.config({ path: ".env" });

class TestPriceClient extends PriceClient {
  constructor(logger: Logger, priceFeeds: PriceFeedAdapter[]) {
    super(logger, priceFeeds);
  }

  getProtectedPriceCache(currency: string): PriceCache {
    return this.getPriceCache(currency);
  }
}

class TestPriceFeed implements PriceFeedAdapter {
  public priceRequest: string[] = [];
  public prices: { [currency: string]: PriceCache } = {};

  constructor(public readonly name = "TestPriceFeed") {}

  async getPriceByAddress(address: string, currency = "usd"): Promise<TokenPrice> {
    const tokenPrices = await this.getPricesByAddress([address], currency);
    return tokenPrices[0];
  }

  async getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    this.priceRequest = addresses;
    const _addresses = addresses.map((address) => address.toLowerCase());

    // Return each cached price that overlaps with the requested list of addresses.
    return (
      Object.entries(this.prices[currency])
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .filter(([address, _]) => _addresses.includes(address.toLowerCase()))
        .map(([address, tokenPrice]) => {
          const { price, timestamp } = tokenPrice;
          return { address, price, timestamp };
        })
    );
  }
}

const maxPriceAge = 600;

// ACX must be defined separately until it is supported by CoinGecko.
const acxAddr = "0x44108f0223a3c3028f5fe7aec7f9bb2e66bef82f";
const addresses: { [symbol: string]: string } = {
  // lower-case
  UMA: "0x04fa0d235c4abf4bcf4787af4cf447de572ef828",
  // checksummed
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

function validateTokenPrice(tokenPrice: TokenPrice, address: string, timestamp: number) {
  assert.ok(tokenPrice);
  assert(tokenPrice.address === address, `${address} !== ${tokenPrice.address}`);
  assert(tokenPrice.price > 0, `${tokenPrice.price} <= 0`);
  assert(tokenPrice.timestamp > 0, `${tokenPrice.timestamp} <= 0`);
  assert(
    tokenPrice.timestamp > timestamp - maxPriceAge,
    `${tokenPrice.timestamp} <= ${timestamp - maxPriceAge} (timestamp: ${timestamp}, maxPriceAge: ${maxPriceAge})`
  );
}

// this requires e2e testing, should only test manually for now
describe("PriceClient", function () {
  const dummyLogger: winston.Logger = winston.createLogger({
    level: "debug",
    transports: [new winston.transports.Console()],
  });

  const testAddress = addresses["UMA"];
  const baseCurrency = "usd";

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
      feedNames.map((feedName) => new acrossApi.PriceFeed({ name: feedName }))
    );
    expect(feedNames).toEqual(pc.listPriceFeeds());
  });

  test("getPriceByAddress: Across API", async function () {
    pc = new PriceClient(dummyLogger, [new acrossApi.PriceFeed()]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: CoinGecko Free", async function () {
    pc = new PriceClient(dummyLogger, [new coingecko.PriceFeed()]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  // Only attempt to test CG Pro if the environment defines COINGECKO_PRO_API_KEY
  const cgProApiKey: string | undefined = process.env.COINGECKO_PRO_API_KEY;
  const cgProTest = typeof cgProApiKey === "string" && cgProApiKey.length > 0 ? test : test.skip;
  const cgPro = new coingecko.PriceFeed({ apiKey: cgProApiKey });
  cgProTest("getPriceByAddress: CoinGecko Pro", async function () {
    pc = new PriceClient(dummyLogger, [cgPro]);
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: DefiLlama", async function () {
    let price: TokenPrice;
    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed()]);
    price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);

    // Verify that minConfidence works as expected
    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed({ minConfidence: 1.0 })]);
    await expect(pc.getPriceByAddress(testAddress)).rejects.toThrow();

    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed({ minConfidence: 0.0 })]);
    price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Across failover to Across", async function () {
    pc = new PriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1" }),
      new acrossApi.PriceFeed({ name: "Across API (expect pass)" }),
    ]);

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Coingecko failover to Across", async function () {
    const _apiKey = "xxx-fake-apikey";
    pc = new PriceClient(dummyLogger, [
      new coingecko.PriceFeed({ name: "CoinGecko Pro (expect fail)", apiKey: _apiKey }),
      new acrossApi.PriceFeed({ name: "Across API (expect pass)" }),
    ]);

    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  test("getPriceByAddress: Complete price lookup failure", async function () {
    pc = new PriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API #1 (expect fail)", host: "127.0.0.1" }),
      new acrossApi.PriceFeed({ name: "Across API #2 (expect fail)", host: "127.0.0.1" }),
    ]);
    await expect(pc.getPriceByAddress(testAddress)).rejects.toThrow();
  });

  test("getPriceByAddress: Across API timeout", async function () {
    const acrossPriceFeed: acrossApi.PriceFeed = new acrossApi.PriceFeed({ name: "Across API (timeout)" });
    pc = new PriceClient(dummyLogger, [acrossPriceFeed]);

    acrossPriceFeed.timeout = 1; // mS
    await expect(pc.getPriceByAddress(testAddress)).rejects.toThrow();

    acrossPriceFeed.timeout = 10000; // mS
    const price: TokenPrice = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  // Ensure that all price adapters return a price of 1WETH/ETH and 1USDC/USD.
  test("getPriceByAddress: Price Coherency", async function () {
    // Note: Beware of potential rate-limiting when using CoinGecko Free.
    const priceFeeds: PriceFeedAdapter[] = [
      new acrossApi.PriceFeed(),
      new coingecko.PriceFeed({ apiKey: cgProApiKey }),
    ];

    const parityTokens: [string, string][] = [
      ["usd", addresses["USDC"]],
      ["eth", addresses["WETH"]],
    ];

    for (const priceFeed of priceFeeds) {
      pc = new PriceClient(dummyLogger, [priceFeed]);

      for (const [baseCurrency, address] of parityTokens) {
        const tokenPrice: TokenPrice = await pc.getPriceByAddress(address, baseCurrency);
        validateTokenPrice(tokenPrice, address, beginTs);
        assert.ok(Math.abs(tokenPrice.price - 1) < 0.05);
      }
    }
  });

  test("getPriceByAddress: Address case insensitivity", async function () {
    // Instantiate a custom subclass of PriceClient.
    const pc: TestPriceClient = new TestPriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1" }),
    ]);

    // Load the cache with lower-case addresses, then query with an upper-case address.
    // Price lookup is forced to fail, so if the pre-loaded data is returned then the
    // PriceClient is case-insenstive.
    const priceCache: PriceCache = pc.getProtectedPriceCache(baseCurrency);
    Object.values(addresses).forEach(async (addr: string) => {
      const addrLower = addr.toLowerCase();
      const addrUpper = addr.toUpperCase();

      const expected: TokenPrice = {
        address: "unused",
        price: Math.random() * 10,
        timestamp: msToS(Date.now()) - 5,
      };
      priceCache[addrLower] = expected;

      const token: TokenPrice = await pc.getPriceByAddress(addrUpper, baseCurrency);
      validateTokenPrice(token, addrUpper, beginTs);
      assert.ok(token.price === expected.price, `${token.price} !== ${expected.price}`);
      assert.ok(token.timestamp === expected.timestamp, `${token.timestamp} !== ${expected.timestamp}`);
    });
  });

  test("getPriceByAddress: Validate price cache", async function () {
    // Instantiate a custom subclass of PriceClient; load the cache and force price lookup failures.
    const pc: TestPriceClient = new TestPriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1" }),
    ]);

    const priceCache: PriceCache = pc.getProtectedPriceCache(baseCurrency);
    pc.maxPriceAge = 600; // Bound timestamps by 10 minutes

    // Pre-populate cache with lower-case addresses.
    for (let i = 0; i < 10; ++i) {
      const addr = `0x${i.toString(16).padStart(42, "0")}`.toLowerCase(); // Non-existent
      priceCache[addr] = {
        address: addr,
        price: Math.random() * (1 + i),
        timestamp: beginTs - pc.maxPriceAge + (1 + i),
      };
    }

    // Verify cache hit for valid timestamps.
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      const token: TokenPrice = await pc.getPriceByAddress(addr, baseCurrency);

      validateTokenPrice(token, addr, pc.maxPriceAge);
      assert.ok(token.price === expected.price, `${token.price} !== ${expected.price}`);
      assert.ok(token.timestamp === expected.timestamp, `${token.timestamp} !== ${expected.timestamp}`);
    }

    // Invalidate all cached results and verify failed price lookup.
    pc.maxPriceAge = 1; // seconds
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      await expect(pc.getPriceByAddress(addr, baseCurrency)).rejects.toThrow();
    }
  });

  test("getPricesByAddress: Verify price retrieval", async function () {
    // Note: Beware of potential rate-limiting when using CoinGecko Free.
    const priceFeeds: PriceFeedAdapter[] = [
      new acrossApi.PriceFeed(),
      new coingecko.PriceFeed({ apiKey: cgProApiKey }),
    ];

    for (const priceFeed of priceFeeds) {
      pc = new PriceClient(dummyLogger, [priceFeed]);

      const tokenPrices: TokenPrice[] = await pc.getPricesByAddress(Object.values(addresses));
      expect(tokenPrices.length).toBe(Object.values(addresses).length);
      Object.values(addresses).forEach((address: string) => {
        const tokenPrice: TokenPrice | undefined = tokenPrices.find((tokenPrice) => tokenPrice.address === address);
        assert.ok(tokenPrice, `Could not find address ${address} via ${priceFeed.name}`);
        validateTokenPrice(tokenPrice, address, beginTs);
      });
    }
  });

  test("getPricesByAddress: Price request reduction", async function () {
    // Test Price Feed #1 does not know about ACX, so it provides an incomplete
    // response. Verify that the response from Test Price Feed #1 includes all
    // known tokens, and that the PriceClient proceeds to query Test Price Feed
    // #2 for *only* the remaining delta address.
    const testPriceFeeds: TestPriceFeed[] = [
      new TestPriceFeed("Test Price Feed #1"),
      new TestPriceFeed("Test Price Feed #2"),
    ];

    // Pre-populate the price cache for Test Price Feed #1.
    testPriceFeeds[0].prices["usd"] = Object.fromEntries(
      Object.values(addresses).map((address) => {
        const price = { price: 1.0, timestamp: beginTs } as TokenPrice;
        return [address.toLowerCase(), price];
      })
    );

    testPriceFeeds[1].prices["usd"] = {};
    testPriceFeeds[1].prices["usd"][acxAddr] = { price: 1.0, timestamp: beginTs } as TokenPrice;

    pc = new PriceClient(dummyLogger, testPriceFeeds);

    // PriceClient cache handles lower-case addresses.
    const priceRequest = Object.values(addresses);
    priceRequest.push(acxAddr);
    dummyLogger.debug({ message: "Price requests before.", priceRequest });

    expect(testPriceFeeds[0].priceRequest).toStrictEqual([]);
    expect(testPriceFeeds[1].priceRequest).toStrictEqual([]);

    const prices = await pc.getPricesByAddress(priceRequest);

    expect(prices.length).toBe(priceRequest.length);
    expect(prices.map((price) => price.address)).toStrictEqual(priceRequest);

    // PriceClient maps all input addresses to lower case.
    expect(testPriceFeeds[0].priceRequest).toStrictEqual(priceRequest.map((address) => address.toLowerCase()));
    expect(testPriceFeeds[1].priceRequest).toEqual([acxAddr].map((address) => address.toLowerCase()));
  });
});
