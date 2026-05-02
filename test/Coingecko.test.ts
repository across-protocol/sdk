import winston from "winston";
import { Coingecko, msToS } from "../src/coingecko/Coingecko";
import { CoingeckoPriceNotFoundError } from "../src/coingecko/CoingeckoErrors";
import { expect, sinon } from "./utils";

// Bypass the singleton + protected constructor so each test gets isolated state.
class TestGecko extends Coingecko {
  public constructor(host: string, logger: winston.Logger) {
    super(host, host, logger);
  }
}

const silentLogger = winston.createLogger({
  level: "error",
  transports: [new winston.transports.Console({ silent: true })],
});

const HOST = "https://test.example";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Coingecko", () => {
  let cg: TestGecko;
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    cg = new TestGecko(HOST, silentLogger);
    fetchStub = sinon.stub(globalThis, "fetch");
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("URL encoding (getCurrentPriceBySymbol)", () => {
    it("does not change the URL for normal ASCII symbols", async () => {
      fetchStub.resolves(jsonResponse({ usdc: { usd: 0.999, last_updated_at: msToS(Date.now()) } }));

      await cg.getCurrentPriceBySymbol("USDC", "usd");

      const calledUrl = fetchStub.firstCall.args[0] as string;
      expect(calledUrl).to.include("symbols=USDC");
      expect(calledUrl).to.include("vs_currencies=usd");
      // No percent-escapes for purely ASCII alphanumeric inputs.
      expect(calledUrl).to.not.include("%");
    });

    it("preserves '.' and '-' in symbols (USDC.e, USDH-SPOT) without encoding", async () => {
      fetchStub.resolves(jsonResponse({}));

      await cg.getCurrentPriceBySymbol("USDC.e", "usd").catch(() => undefined);
      expect(fetchStub.firstCall.args[0] as string).to.include("symbols=USDC.e");

      fetchStub.resetHistory();
      fetchStub.resolves(jsonResponse({}));
      await cg.getCurrentPriceBySymbol("USDH-SPOT", "usd").catch(() => undefined);
      expect(fetchStub.firstCall.args[0] as string).to.include("symbols=USDH-SPOT");
    });

    it("percent-encodes non-ASCII symbols and reaches fetch (regression)", async () => {
      // Pre-fix this would throw TypeError: Request path contains unescaped characters
      // *before* fetch was ever called.
      fetchStub.resolves(jsonResponse({}));

      await cg.getCurrentPriceBySymbol("熊猫头", "usd").catch(() => undefined);

      expect(fetchStub.calledOnce).to.equal(true);
      const calledUrl = fetchStub.firstCall.args[0] as string;
      expect(calledUrl).to.include("symbols=%E7%86%8A%E7%8C%AB%E5%A4%B4");
    });

    it("percent-encodes reserved characters in symbols", async () => {
      fetchStub.resolves(jsonResponse({}));
      await cg.getCurrentPriceBySymbol("BTC/USD", "usd").catch(() => undefined);
      expect(fetchStub.firstCall.args[0] as string).to.include("symbols=BTC%2FUSD");
    });
  });

  describe("CoingeckoPriceNotFoundError", () => {
    it("throws when CG returns no entry for the symbol", async () => {
      fetchStub.resolves(jsonResponse({}));

      try {
        await cg.getCurrentPriceBySymbol("UNKNOWN", "usd");
        expect.fail("Expected CoingeckoPriceNotFoundError");
      } catch (e) {
        expect(e).to.be.instanceOf(CoingeckoPriceNotFoundError);
        expect(e).to.be.instanceOf(Error);
        const err = e as CoingeckoPriceNotFoundError;
        expect(err.identifier).to.equal("UNKNOWN");
        expect(err.currency).to.equal("usd");
        expect(err.lookupType).to.equal("symbol");
        expect(err.message).to.include("UNKNOWN");
        expect(err.message).to.include("usd");
      }
    });

    it("throws when CG returns the symbol but not the requested currency", async () => {
      // CG has the token, just not in the requested vs_currency.
      fetchStub.resolves(jsonResponse({ usdc: { eth: 0.0003, last_updated_at: 1000 } }));

      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected CoingeckoPriceNotFoundError");
      } catch (e) {
        expect(e).to.be.instanceOf(CoingeckoPriceNotFoundError);
        expect((e as CoingeckoPriceNotFoundError).lookupType).to.equal("symbol");
        expect((e as CoingeckoPriceNotFoundError).currency).to.equal("usd");
      }
    });

    it("returns the price normally on a valid CG response (no behavior change)", async () => {
      const ts = msToS(Date.now());
      fetchStub.resolves(jsonResponse({ usdc: { usd: 0.9998, last_updated_at: ts } }));

      const [timestamp, price] = await cg.getCurrentPriceBySymbol("USDC", "usd");
      expect(price).to.equal(0.9998);
      expect(timestamp).to.equal(ts.toString());
    });
  });

  describe("CoingeckoPriceNotFoundError class", () => {
    it("populates identifier, currency, and lookupType fields", () => {
      const err = new CoingeckoPriceNotFoundError({
        identifier: "USDC",
        currency: "usd",
        lookupType: "symbol",
      });
      expect(err.identifier).to.equal("USDC");
      expect(err.currency).to.equal("usd");
      expect(err.lookupType).to.equal("symbol");
      expect(err.name).to.equal("CoingeckoPriceNotFoundError");
      expect(err).to.be.instanceOf(Error);
    });

    it("preserves the cause when provided", () => {
      const cause = new Error("upstream");
      const err = new CoingeckoPriceNotFoundError({
        identifier: "X",
        currency: "usd",
        lookupType: "id",
        cause,
      });
      expect(err.cause).to.equal(cause);
    });
  });
});
