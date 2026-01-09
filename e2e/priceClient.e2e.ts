import assert from "assert";
import axios from "axios";
import dotenv from "dotenv";
import winston from "winston";
import { Logger, msToS, PriceCache, PriceClient, PriceFeedAdapter, TokenPrice } from "../src/priceClient/priceClient";
import { acrossApi, coingecko, defaultAdapter, defiLlama } from "../src/priceClient/adapters";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "../src/priceClient/adapters/baseAdapter";
import { assertPromiseError, assertPromisePasses, expect } from "../test/utils";

dotenv.config();

class TestBaseHTTPAdapter extends BaseHTTPAdapter {
  public nRetries = 0;

  constructor(name: string, host: string, { timeout = 500, retries = 1 }: BaseHTTPAdapterArgs) {
    super(name, host, { timeout, retries });
  }

  _query(path: string, urlArgs?: object): Promise<unknown> {
    return this.query(path, urlArgs);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected override sleep(_ms: number): Promise<void> {
    return new Promise((next) => {
      ++this.nRetries;
      next();
    });
  }
}

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
    const [tokenPrice] = await this.getPricesByAddress([address], currency);
    return tokenPrice;
  }

  getPricesByAddress(addresses: string[], currency = "usd"): Promise<TokenPrice[]> {
    this.priceRequest = addresses;
    const _addresses = addresses.map((address) => address.toLowerCase());

    // Return each cached price that overlaps with the requested list of addresses.
    return Promise.resolve(
      Object.entries(this.prices[currency])
        .filter(([address]) => _addresses.includes(address.toLowerCase()))
        .map(([address, { price, timestamp }]) => ({ address, price, timestamp }))
    );
  }
}

// Don't be too strict on obtaining recent prices.
const maxPriceAge = 60 * 60 * 30; // seconds

const addresses = {
  // lower-case
  ACX: "0x44108f0223a3c3028f5fe7aec7f9bb2e66bef82f",
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

describe("PriceClient: BaseHTTPAdapter", function () {
  it("Retry behaviour: All failures", async function () {
    for (const retries of [0, 1, 3, 5, 7, 9]) {
      const name = `BaseHTTPAdapter test w/ ${retries} retries`;
      const baseAdapter = new TestBaseHTTPAdapter(name, "127.0.0.1", { timeout: 1, retries });
      expect(baseAdapter.nRetries).to.be.eq(0);
      await assertPromiseError(baseAdapter._query("", { retries }), `${name} price lookup failure`);
      expect(baseAdapter.nRetries).to.be.eq(retries);
    }
  });

  it("Retry behaviour: Success on the final request", async function () {
    for (const retries of [1, 3, 5, 7, 9]) {
      const name = `BaseHTTPAdapter test w/ success on retry ${retries}`;
      const baseAdapter = new TestBaseHTTPAdapter(name, "127.0.0.1", { timeout: 1, retries });
      expect(baseAdapter.nRetries).to.be.eq(0);

      // Instantiate callback for HTTP response != 2xx.
      const interceptor = axios.interceptors.response.use(
        undefined, // HTTP 2xx.
        function (error) {
          const result = retries && baseAdapter.nRetries === retries ? Promise.resolve({}) : Promise.reject(error);
          return result;
        }
      );

      const response = baseAdapter._query("", { retries });
      await assertPromisePasses(response);
      axios.interceptors.response.eject(interceptor); // Cleanup ASAP.

      expect(baseAdapter.nRetries).to.be.eq(retries);
    }
  });
});

// this requires e2e testing, should only test manually for now
describe("PriceClient", function () {
  const dummyLogger = winston.createLogger({
    level: "debug",
    transports: [new winston.transports.Console()],
  });

  const testAddress = addresses.UMA;
  const baseCurrency = "usd";

  let pc: PriceClient;
  let beginTs: number;

  beforeEach(() => {
    beginTs = msToS(Date.now());
  });

  it("Price feed ordering", function () {
    // Generate a list with ~random names; nb. names are not (currently?) required to be unique.
    const feedNames = Array(3)
      .fill("Test PriceFeed")
      .map((name) => `${name}-${Math.trunc(Math.random() * 100) + 1}`);

    pc = new PriceClient(
      dummyLogger,
      feedNames.map((feedName) => new acrossApi.PriceFeed({ name: feedName }))
    );
    const expectedFeeds = [...feedNames, "Default Adapter"];
    expect(expectedFeeds).to.deep.eq(pc.listPriceFeeds());
  });

  it("getPriceByAddress: Across API", async function () {
    pc = new PriceClient(dummyLogger, [new acrossApi.PriceFeed()]);
    const price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  it("getPriceByAddress: CoinGecko Free", async function () {
    pc = new PriceClient(dummyLogger, [new coingecko.PriceFeed()]);
    const price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  // Only attempt to test CG Pro if the environment defines COINGECKO_PRO_API_KEY
  const { COINGECKO_PRO_API_KEY: cgProApiKey } = process.env;
  const cgProTest = typeof cgProApiKey === "string" && cgProApiKey.length > 0 ? it : it.skip;
  const cgPro = new coingecko.PriceFeed({ apiKey: cgProApiKey });
  cgProTest("getPriceByAddress: CoinGecko Pro", async function () {
    pc = new PriceClient(dummyLogger, [cgPro]);
    const price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  it("getPriceByAddress: DefiLlama", async function () {
    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed()]);
    let price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);

    // Verify that minConfidence works as expected
    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed({ minConfidence: 1.0 })]);
    price = await pc.getPriceByAddress(testAddress);
    expect(price.price).to.equal(0);
    expect(price.timestamp).to.equal(0);

    pc = new PriceClient(dummyLogger, [new defiLlama.PriceFeed({ minConfidence: 0.0 })]);
    price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  it("getPriceByAddress: Across failover to Across", async function () {
    pc = new PriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1", retries: 0 }),
      new acrossApi.PriceFeed({ name: "Across API (expect pass)" }),
    ]);

    const price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  it("getPriceByAddress: Coingecko failover to Across", async function () {
    const _apiKey = "xxx-fake-apikey";
    pc = new PriceClient(dummyLogger, [
      new coingecko.PriceFeed({ name: "CoinGecko Pro (expect fail)", apiKey: _apiKey, retries: 0 }),
      new acrossApi.PriceFeed({ name: "Across API (expect pass)" }),
    ]);

    const price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  it("getPriceByAddress: Complete price lookup failure", async function () {
    pc = new PriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API #1 (expect fail)", host: "127.0.0.1", retries: 0 }),
      new acrossApi.PriceFeed({ name: "Across API #2 (expect fail)", host: "127.0.0.1", retries: 0 }),
    ]);
    const price = await pc.getPriceByAddress(testAddress);
    expect(price.price).to.equal(0);
    expect(price.timestamp).to.equal(0);
  });

  it("getPriceByAddress: Across API timeout", async function () {
    const acrossPriceFeed = new acrossApi.PriceFeed({ name: "Across API (timeout)", retries: 0 });
    pc = new PriceClient(dummyLogger, [acrossPriceFeed]);

    acrossPriceFeed.timeout = 1; // mS
    let price = await pc.getPriceByAddress(testAddress);
    expect(price.price).to.equal(0);
    expect(price.timestamp).to.equal(0);

    acrossPriceFeed.timeout = 10000; // mS
    price = await pc.getPriceByAddress(testAddress);
    validateTokenPrice(price, testAddress, beginTs);
  });

  // Ensure that all price adapters return a price of 1WETH/ETH and 1USDC/USD.
  it("getPriceByAddress: Price Coherency", async function () {
    // Note: Beware of potential rate-limiting when using CoinGecko Free.
    const priceFeeds = [new acrossApi.PriceFeed(), new coingecko.PriceFeed({ apiKey: cgProApiKey })];

    const parityTokens: [string, string][] = [
      ["usd", addresses["USDC"]],
      ["eth", addresses["WETH"]],
    ];

    for (const priceFeed of priceFeeds) {
      pc = new PriceClient(dummyLogger, [priceFeed]);

      for (const [baseCurrency, address] of parityTokens) {
        const tokenPrice = await pc.getPriceByAddress(address, baseCurrency);
        validateTokenPrice(tokenPrice, address, beginTs);
        assert.ok(Math.abs(tokenPrice.price - 1) < 0.05);
      }
    }
  });

  it("getPriceByAddress: Address case insensitivity", function () {
    // Instantiate a custom subclass of PriceClient.
    const pc = new TestPriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1", retries: 0 }),
    ]);

    // Load the cache with lower-case addresses, then query with an upper-case address.
    // Price lookup is forced to fail, so if the pre-loaded data is returned then the
    // PriceClient is case-insensitive.
    const priceCache = pc.getProtectedPriceCache(baseCurrency);
    Object.values(addresses).forEach(async (addr: string) => {
      const addrLower = addr.toLowerCase();
      const addrUpper = addr.toUpperCase();

      const expected: TokenPrice = {
        address: "unused",
        price: Math.random() * 10,
        timestamp: msToS(Date.now()) - 5,
      };
      priceCache[addrLower] = expected;

      const token = await pc.getPriceByAddress(addrUpper, baseCurrency);
      validateTokenPrice(token, addrUpper, beginTs);
      assert.ok(token.price === expected.price, `${token.price} !== ${expected.price}`);
      assert.ok(token.timestamp === expected.timestamp, `${token.timestamp} !== ${expected.timestamp}`);
    });
  });

  it("getPriceByAddress: Validate price cache", async function () {
    // Instantiate a custom subclass of PriceClient; load the cache and force price lookup failures.
    const pc = new TestPriceClient(dummyLogger, [
      new acrossApi.PriceFeed({ name: "Across API (expect fail)", host: "127.0.0.1", retries: 0 }),
    ]);

    const priceCache = pc.getProtectedPriceCache(baseCurrency);
    pc.maxPriceAge = 600; // Bound timestamps by 10 minutes

    // Pre-populate cache with lower-case addresses.
    for (let i = 0; i < 10; ++i) {
      const address = `0x${i.toString(16).padStart(42, "0")}`.toLowerCase(); // Non-existent
      priceCache[address] = {
        address,
        price: Math.random() * (1 + i),
        timestamp: beginTs - pc.maxPriceAge + (1 + i),
      };
    }

    // Verify cache hit for valid timestamps.
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      const token = await pc.getPriceByAddress(addr, baseCurrency);

      validateTokenPrice(token, addr, pc.maxPriceAge);
      assert.ok(token.price === expected.price, `${token.price} !== ${expected.price}`);
      assert.ok(token.timestamp === expected.timestamp, `${token.timestamp} !== ${expected.timestamp}`);
    }
  });

  it("getPricesByAddress: Verify price retrieval", async function () {
    // Note: Beware of potential rate-limiting when using CoinGecko Free.
    const priceFeeds = [new acrossApi.PriceFeed(), new coingecko.PriceFeed({ apiKey: cgProApiKey })];

    for (const priceFeed of priceFeeds) {
      pc = new PriceClient(dummyLogger, [priceFeed]);

      const tokenPrices = await pc.getPricesByAddress(Object.values(addresses));
      expect(tokenPrices.length).to.be.eq(Object.values(addresses).length);
      Object.values(addresses).forEach((address) => {
        const tokenPrice = tokenPrices.find((tokenPrice) => tokenPrice.address === address);
        assert.ok(tokenPrice, `Could not find address ${address} via ${priceFeed.name}`);
        validateTokenPrice(tokenPrice, address, beginTs);
      });
    }
  });

  it("getPricesByAddress: Price request reduction", async function () {
    // Test Price Feed #1 does not know about ACX, so it provides an incomplete
    // response. Verify that the response from Test Price Feed #1 includes all
    // known tokens, and that the PriceClient proceeds to query Test Price Feed
    // #2 for *only* the remaining delta address.
    const testPriceFeeds = [new TestPriceFeed("Test Price Feed #1"), new TestPriceFeed("Test Price Feed #2")];

    // Pre-populate the price cache for Test Price Feed #1.
    testPriceFeeds[0].prices["usd"] = Object.fromEntries(
      Object.values(addresses).map((address) => {
        const price = { price: 1.0, timestamp: beginTs } as TokenPrice;
        return [address.toLowerCase(), price];
      })
    );

    testPriceFeeds[1].prices["usd"] = {
      [addresses.ACX]: { price: 1.0, timestamp: beginTs } as TokenPrice,
    };

    pc = new PriceClient(dummyLogger, testPriceFeeds);

    // PriceClient cache handles lower-case addresses.
    const priceRequest = Object.values(addresses);
    dummyLogger.debug({ message: "Price requests before.", priceRequest });

    expect(testPriceFeeds[0].priceRequest).to.deep.eq([]);
    expect(testPriceFeeds[1].priceRequest).to.deep.eq([]);

    const prices = await pc.getPricesByAddress(priceRequest);
    expect(prices.length).to.be.eq(priceRequest.length);
    expect(prices.map(({ address }) => address)).to.deep.eq(priceRequest);
  });

  it("getPriceByAddress: DefaultAdapter with fixed prices", async function () {
    // Test DefaultAdapter with custom fixed prices
    const fixedPrices = {
      usd: {
        [addresses.ACX]: 0.5,
        [addresses.UMA]: 2.5,
        [addresses.DAI]: 1.0,
        [addresses.USDC]: 1.0,
        [addresses.WETH]: 2500.0,
      },
    };

    pc = new PriceClient(dummyLogger, [new defaultAdapter.PriceFeed(fixedPrices)]);

    // Verify each token returns the correct fixed price
    for (const [address, expectedPrice] of Object.entries(fixedPrices.usd)) {
      const tokenPrice = await pc.getPriceByAddress(address, baseCurrency);
      assert.ok(tokenPrice);
      expect(tokenPrice.address).to.equal(address);
      expect(tokenPrice.price).to.equal(expectedPrice);
      expect(tokenPrice.timestamp).to.equal(0);
    }
  });

  it("getPriceByAddress: DefaultAdapter returns zero for unknown addresses", async function () {
    // Test DefaultAdapter returns 0 for addresses without fixed prices
    const fixedPrices = {
      usd: {
        [addresses.ACX]: 0.5,
      },
    };

    pc = new PriceClient(dummyLogger, [new defaultAdapter.PriceFeed(fixedPrices)]);

    // Known address should return fixed price
    let tokenPrice = await pc.getPriceByAddress(addresses.ACX, baseCurrency);
    expect(tokenPrice.price).to.equal(0.5);
    expect(tokenPrice.timestamp).to.equal(0);

    // Unknown address should return 0
    tokenPrice = await pc.getPriceByAddress(addresses.UMA, baseCurrency);
    expect(tokenPrice.price).to.equal(0);
    expect(tokenPrice.timestamp).to.equal(0);
  });

  it("getPricesByAddress: DefaultAdapter with fixed prices", async function () {
    // Test DefaultAdapter batch price retrieval
    const fixedPrices = {
      usd: {
        [addresses.ACX]: 0.5,
        [addresses.UMA]: 2.5,
        [addresses.WETH]: 2500.0,
      },
    };

    pc = new PriceClient(dummyLogger, [new defaultAdapter.PriceFeed(fixedPrices)]);

    const priceRequest = [addresses.ACX, addresses.UMA, addresses.DAI, addresses.WETH];
    const tokenPrices = await pc.getPricesByAddress(priceRequest);

    expect(tokenPrices.length).to.equal(priceRequest.length);

    // Verify known addresses have fixed prices
    Object.entries(fixedPrices.usd).forEach(([address, price]) => {
      const tokenPrice = tokenPrices.find((tp) => tp.address === address);
      expect(tokenPrice).to.exist;
      expect(tokenPrice!.price).to.equal(price);
    });

    // Unknown address should return 0
    const daiPrice = tokenPrices.find((tp) => tp.address === addresses.DAI);
    expect(daiPrice).to.exist;
    expect(daiPrice!.price).to.equal(0);
  });
});
