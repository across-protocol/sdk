import winston from "winston";
import { Logger, msToS, PriceClient, PriceFeedAdapter, TokenPrice } from "../src/priceClient/priceClient";
import { expect } from "./utils";

const dummyLogger: Logger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const CURRENCY = "usd";
const NOW = msToS(Date.now());

function tp(address: string, price: number, timestamp = NOW): TokenPrice {
  return { address, price, timestamp };
}

/**
 * Mock feed that records each getPricesByAddress call and returns
 * a configurable response (or throws) per call.
 */
class MockPriceFeed implements PriceFeedAdapter {
  public readonly name: string;
  public requestLog: string[][] = [];
  private responsePerCall: (TokenPrice[] | Error)[] = [];

  constructor(name: string) {
    this.name = name;
  }

  setResponses(...responses: (TokenPrice[] | Error)[]): void {
    this.responsePerCall = [...responses];
  }

  async getPriceByAddress(address: string, currency: string): Promise<TokenPrice> {
    const [tokenPrice] = await this.getPricesByAddress([address], currency);
    return tokenPrice;
  }

  async getPricesByAddress(addresses: string[], _currency: string): Promise<TokenPrice[]> {
    this.requestLog.push([...addresses]);
    const response = this.responsePerCall.shift();
    if (response === undefined) {
      throw new Error(`${this.name}: no response configured`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe("PriceClient#updatePrices", function () {
  it("first provider returns all non-zero prices: no further providers called", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    feed1.setResponses([tp(ADDR_A, 1), tp(ADDR_B, 2), tp(ADDR_C, 3)]);

    const pc = new PriceClient(dummyLogger, [feed1], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B, ADDR_C], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed1.requestLog[0]).to.have.members([ADDR_A, ADDR_B, ADDR_C]);
    expect(result.map((r) => r.price)).to.deep.equal([1, 2, 3]);
  });

  it("first provider throws: second provider called with same addresses successfully returns prices", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses(new Error("Feed1 failed"));
    feed2.setResponses([tp(ADDR_A, 10), tp(ADDR_B, 20)]);

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.have.members([ADDR_A, ADDR_B]);
    expect(result.map((r) => r.price)).to.deep.equal([10, 20]);
  });

  it("first provider returns some skipped (missing): second provider called only for skipped", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses([tp(ADDR_A, 1)]); // only A, so B and C are skipped
    feed2.setResponses([tp(ADDR_B, 2), tp(ADDR_C, 3)]);

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B, ADDR_C], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed1.requestLog[0]).to.have.members([ADDR_A, ADDR_B, ADDR_C]);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.have.members([ADDR_B, ADDR_C]);
    expect(result.find((r) => r.address === ADDR_A)!.price).to.equal(1);
    expect(result.find((r) => r.address === ADDR_B)!.price).to.equal(2);
    expect(result.find((r) => r.address === ADDR_C)!.price).to.equal(3);
  });

  it("first provider returns some price 0: second provider called for those addresses", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses([tp(ADDR_A, 1), tp(ADDR_B, 0), tp(ADDR_C, 3)]); // B is 0
    feed2.setResponses([tp(ADDR_B, 5)]); // second feed returns non-zero for B

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B, ADDR_C], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.deep.equal([ADDR_B]);
    expect(result.find((r) => r.address === ADDR_A)!.price).to.equal(1);
    expect(result.find((r) => r.address === ADDR_B)!.price).to.equal(5);
    expect(result.find((r) => r.address === ADDR_C)!.price).to.equal(3);
  });

  it("two consecutive providers return 0 for same address: we keep 0 and stop retrying", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    const feed3 = new MockPriceFeed("Feed3");
    feed1.setResponses([tp(ADDR_A, 1), tp(ADDR_B, 0)]); // B is 0
    feed2.setResponses([tp(ADDR_B, 0)]); // still 0
    // feed3 should not be called for ADDR_B (we gave up)

    const pc = new PriceClient(dummyLogger, [feed1, feed2, feed3], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.deep.equal([ADDR_B]);
    expect(feed3.requestLog.length).to.equal(0);
    expect(result.find((r) => r.address === ADDR_A)!.price).to.equal(1);
    expect(result.find((r) => r.address === ADDR_B)!.price).to.equal(0);
  });

  it("first provider returns 0, second returns non-zero: we use non-zero", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses([tp(ADDR_A, 0)]);
    feed2.setResponses([tp(ADDR_A, 42)]);

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    const result = await pc.getPricesByAddress([ADDR_A], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(result[0].price).to.equal(42);
  });

  it("all providers throw: we throw at the end", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses(new Error("E1"));
    feed2.setResponses(new Error("E2"));

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    await expect(pc.getPricesByAddress([ADDR_A], CURRENCY)).to.be.rejectedWith(
      /Price lookup failed against all price feeds/
    );
    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
  });

  it("some addresses never returned by any provider: we throw with skipped list", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    feed1.setResponses([tp(ADDR_A, 1)]); // only A
    feed2.setResponses([tp(ADDR_B, 2)]); // only B, C still missing

    const pc = new PriceClient(dummyLogger, [feed1, feed2], true);

    await expect(pc.getPricesByAddress([ADDR_A, ADDR_B, ADDR_C], CURRENCY)).to.be.rejectedWith(
      /Price lookup failed against all price feeds/
    );
    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.include(ADDR_B);
    expect(feed2.requestLog[0]).to.include(ADDR_C);
  });

  it("mix: skipped + zero; next provider gets both; zero from 2 consecutive gives up", async function () {
    const feed1 = new MockPriceFeed("Feed1");
    const feed2 = new MockPriceFeed("Feed2");
    const feed3 = new MockPriceFeed("Feed3");
    // Feed1: A=1, B=0, C missing (skipped)
    feed1.setResponses([tp(ADDR_A, 1), tp(ADDR_B, 0)]);
    // Feed2: B still 0, C=3
    feed2.setResponses([tp(ADDR_B, 0), tp(ADDR_C, 3)]);
    // Feed3 should not be called (B gave up, C resolved)

    const pc = new PriceClient(dummyLogger, [feed1, feed2, feed3], true);

    const result = await pc.getPricesByAddress([ADDR_A, ADDR_B, ADDR_C], CURRENCY);

    expect(feed1.requestLog.length).to.equal(1);
    expect(feed2.requestLog.length).to.equal(1);
    expect(feed2.requestLog[0]).to.have.members([ADDR_B, ADDR_C]);
    expect(feed3.requestLog.length).to.equal(0);
    expect(result.find((r) => r.address === ADDR_A)!.price).to.equal(1);
    expect(result.find((r) => r.address === ADDR_B)!.price).to.equal(0);
    expect(result.find((r) => r.address === ADDR_C)!.price).to.equal(3);
  });
});
