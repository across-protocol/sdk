import assert from "assert";
import dotenv from "dotenv";
import winston from "winston";
import * as coingecko from "./Coingecko";
dotenv.config({ path: ".env" });

const Coingecko = coingecko.Coingecko;
const msToS = coingecko.msToS;
type CoinGeckoPrice = coingecko.CoinGeckoPrice;

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

class TestGecko extends Coingecko {

  private static testInstance: TestGecko | undefined;

  public static get(logger: winston.Logger) {
    if (!this.testInstance)
      this.testInstance = new TestGecko(logger);
    return this.testInstance;
  }

  // Hack to return protected getPriceCache.
  _getPriceCache(currency: string, platform_id: string): { [addr: string]: CoinGeckoPrice } {
    return this.getPriceCache(currency, platform_id);
  }

  constructor(logger: winston.Logger) {
    super("127.0.0.1", "127.0.0.1", logger);
  };
}

// this requires e2e testing, should only test manually for now
describe("coingecko", function () {
  let cg: coingecko.Coingecko;
  test("init", function () {
    cg = Coingecko.get(dummyLogger, process.env.COINGECKO_PRO_API_KEY);
    assert.ok(cg);
  });
  test("getContractDetails", async function () {
    const address = "0x04fa0d235c4abf4bcf4787af4cf447de572ef828";
    const result = await cg.getContractDetails(address);
    assert.ok(result);
  });
  test("getCurrentPriceByContract", async function () {
    const address = "0x04fa0d235c4abf4bcf4787af4cf447de572ef828";
    const result = await cg.getCurrentPriceByContract(address);
    assert.ok(result);
    assert.equal(result.length, 2);
  });
  test("getContractPrices", async function () {
    const addresses = [
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "0xeca82185adCE47f39c684352B0439f030f860318",
      "0xEB4C2781e4ebA804CE9a9803C67d0893436bB27D",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
      "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828",
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0xba100000625a3754423978a60c9317c58a424e3D",
      "0x261b45D85cCFeAbb11F022eBa346ee8D1cd488c0",
      "0x7e7E112A68d8D2E221E11047a72fFC1065c38e1a",
      "0x1571eD0bed4D987fe2b498DdBaE7DFA19519F651",
      "0x8798249c2E607446EfB7Ad49eC89dD1865Ff4272",
      "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
      "0x5F64Ab1544D28732F0A24F4713c2C8ec0dA089f0",
    ];

    const result: CoinGeckoPrice[] = await cg.getContractPrices(addresses);
    assert.equal(result.length, addresses.length);
    result.forEach((result: CoinGeckoPrice) => {
      assert.ok(result.price);
      assert.ok(result.timestamp);
      assert.ok(result.address);
      assert.ok(addresses.includes(result.address));
    });
  });
  test("getHistoricContractPrices", async function () {
    const address = "0x04fa0d235c4abf4bcf4787af4cf447de572ef828";
    // 4 weeks
    const from = Date.now() - 28 * 24 * 1000 * 60 * 60;
    const to = Date.now();
    const result = await cg.getHistoricContractPrices(address, from, to);
    assert.ok(result && result.length);
  });
  test("Fallback to Pro", async function () {
    // Default test timeout of 5000ms is too short usually for this test. Manually expand it.
    jest.setTimeout(30000);
    // Send tons of basic requests so that we hit pro. Basic has a ~50/min rate limit but this varies. In practice
    // its a bit lower more like ~20-30/min.

    cg.maxPriceAge = 0; // Disable cache to force price lookups
    for (let i = 0; i < 20; i++) {
      assert.ok(await cg.getCurrentPriceByContract("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "eth"));
    }
  });
  test("Validate price cache", async function () {
    // Don't lookup against CoinGecko.
    let tg: TestGecko = TestGecko.get(dummyLogger);
    assert.ok(tg);

    const baseCurrency = "eth";
    const network = "ethereum";

    const priceCache: { [addr: string]: CoinGeckoPrice } = tg._getPriceCache(baseCurrency, network);
    tg.maxPriceAge = 600; // Bound timestamps by 10 minutes
    for (let i = 0; i < 10; ++i) {
      const addr = `0x${i.toString(16).padStart(42, "0")}`; // Non-existent, ensure CG lookup would fail.
      priceCache[addr] = {
        address: addr,
        price: Math.random() * (1 + i),
        timestamp: msToS(Date.now()) - tg.maxPriceAge + (1 + i),
      };
    }

    // Verify cache hit for valid timestamps.
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      const result: [timestamp: string, price: number] = await tg.getCurrentPriceByContract(addr, baseCurrency);
      const timestamp: string = result[0];
      const price: number = result[1];

      assert.ok(timestamp === expected.timestamp.toString(), `${expected.timestamp} !== ${timestamp}`);
      assert.ok(price === expected.price, `${expected.price} !== ${price}`);
    }

    // Invalidate all cached results and verify failed price lookup.
    tg.maxPriceAge = 1; // seconds
    for (const expected of Object.values(priceCache)) {
      const addr: string = expected.address;
      await expect(tg.getCurrentPriceByContract(addr, baseCurrency)).rejects.toThrow();
    }
  });
});
