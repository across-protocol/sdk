import winston from "winston";
import { Coingecko, msToS } from "../src/coingecko/Coingecko";
import { CoingeckoPriceNotFoundError } from "../src/coingecko/CoingeckoErrors";
import { HttpError, isHttpError } from "../src/utils";
import { expect, sinon } from "./utils";

// Bypass the singleton + protected constructor so each test gets isolated state.
class TestGecko extends Coingecko {
  public constructor(host: string, logger: winston.Logger, proHost = host, apiKey?: string) {
    super(host, proHost, logger, apiKey);
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

// Symbols that real callers (and prod logs) send. None of these contain
// reserved URL characters — verifying they pass through `encodeURIComponent`
// byte-identical is the regression guard that the encoding fix doesn't
// silently change the wire format for the happy path.
const PASSTHROUGH_SYMBOLS = [
  // Common majors
  "USDC",
  "USDT",
  "DAI",
  "ETH",
  "WETH",
  "WBTC",
  "USDE",
  // Native / wrapped natives across chains
  "MATIC",
  "POL",
  "SOL",
  "ARB",
  "OP",
  // Stables and remappings actually exercised by quote-api
  "USDC.e",
  "USDH-SPOT",
  "PATHUSD",
  // Symbols seen failing in prod logs (ASCII — not the encoding bug, but
  // the not-found path) — these must still hit fetch with the literal
  // symbol so CG can answer authoritatively.
  "CENT",
];

const PASSTHROUGH_CURRENCIES = ["usd", "eth", "sol", "btc"];

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
    for (const symbol of PASSTHROUGH_SYMBOLS) {
      it(`leaves '${symbol}' byte-identical in the request URL`, async () => {
        // Stub returns a valid response so the call completes when CG knows
        // the symbol, and an empty body when it doesn't — neither case
        // should affect what URL was sent.
        fetchStub.resolves(jsonResponse({}));
        await cg.getCurrentPriceBySymbol(symbol, "usd").catch(() => undefined);
        expect(fetchStub.calledOnce).to.equal(true);
        const calledUrl = fetchStub.firstCall.args[0] as string;
        expect(calledUrl).to.include(`symbols=${symbol}`);
      });
    }

    for (const currency of PASSTHROUGH_CURRENCIES) {
      it(`leaves currency '${currency}' byte-identical in the request URL`, async () => {
        fetchStub.resolves(jsonResponse({}));
        await cg.getCurrentPriceBySymbol("USDC", currency).catch(() => undefined);
        const calledUrl = fetchStub.firstCall.args[0] as string;
        expect(calledUrl).to.include(`vs_currencies=${currency}`);
      });
    }

    it("emits no percent-escapes at all for purely alphanumeric inputs", async () => {
      fetchStub.resolves(jsonResponse({ usdc: { usd: 0.999, last_updated_at: msToS(Date.now()) } }));
      await cg.getCurrentPriceBySymbol("USDC", "usd");
      const calledUrl = fetchStub.firstCall.args[0] as string;
      expect(calledUrl).to.not.include("%");
    });

    it("percent-encodes non-ASCII symbols and reaches fetch (regression: '熊猫头')", async () => {
      // Pre-fix: Node's http would throw `Request path contains unescaped characters`
      // *before* fetch was ever called — observed in prod for `?symbol=熊猫头`.
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

  describe("Pro host routing (getCurrentPriceBySymbol)", () => {
    // Regression: the basic host answers symbol lookups with an empty 200, so
    // the catch-based fallback never fired and symbol prices always 404'd even
    // with a Pro key configured. Symbol lookups must go straight to Pro.
    const BASIC_HOST = "https://basic.example";
    const PRO_HOST = "https://pro.example";

    it("routes to the Pro host when an API key is set", async () => {
      const gecko = new TestGecko(BASIC_HOST, silentLogger, PRO_HOST, "test-pro-key");
      fetchStub.resolves(jsonResponse({ usdc: { usd: 0.9999, last_updated_at: msToS(Date.now()) } }));

      const [, price] = await gecko.getCurrentPriceBySymbol("USDC", "usd");

      expect(price).to.equal(0.9999);
      expect(fetchStub.calledOnce).to.equal(true);
      const calledUrl = fetchStub.firstCall.args[0] as string;
      expect(calledUrl.startsWith(PRO_HOST)).to.equal(true);
    });

    it("uses the basic host when no API key is set", async () => {
      const gecko = new TestGecko(BASIC_HOST, silentLogger, PRO_HOST);
      fetchStub.resolves(jsonResponse({ usdc: { usd: 0.9999, last_updated_at: msToS(Date.now()) } }));

      await gecko.getCurrentPriceBySymbol("USDC", "usd");

      const calledUrl = fetchStub.firstCall.args[0] as string;
      expect(calledUrl.startsWith(BASIC_HOST)).to.equal(true);
    });
  });

  describe("URL encoding (getContractPrices)", () => {
    const ETH_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const ETH_DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";

    it("does not encode hex contract addresses or standard platform ids", async () => {
      fetchStub.resolves(jsonResponse({}));
      await cg.getContractPrices([ETH_USDC, ETH_DAI], "usd", "ethereum").catch(() => undefined);
      const calledUrl = fetchStub.firstCall.args[0] as string;
      // Expect both addresses joined by the literal %2C separator (CG's own format),
      // with no further percent-escapes anywhere in the path/query.
      expect(calledUrl).to.include(`contract_addresses=${ETH_USDC}%2C${ETH_DAI}`);
      expect(calledUrl).to.include("simple/token_price/ethereum?");
      expect(calledUrl).to.include("vs_currencies=usd");
    });

    it("does not encode hyphenated platform ids (polygon-pos, arbitrum-one)", async () => {
      for (const platform of ["polygon-pos", "arbitrum-one", "optimistic-ethereum", "base"]) {
        fetchStub.resetHistory();
        fetchStub.resolves(jsonResponse({}));
        await cg.getContractPrices([ETH_USDC], "usd", platform).catch(() => undefined);
        const calledUrl = fetchStub.firstCall.args[0] as string;
        expect(calledUrl).to.include(`simple/token_price/${platform}?`);
      }
    });
  });

  describe("CoingeckoPriceNotFoundError vs upstream errors", () => {
    // Callers (e.g. quote-api's handleErrorCondition) need to distinguish:
    //   - "Coingecko has no price for this token"  -> 404 to the user
    //   - "Coingecko / network is unhealthy"        -> 502 to the user
    // Both used to surface as opaque thrown Errors. These tests pin down
    // that the typed error is ONLY thrown for the not-found case.

    it("throws CoingeckoPriceNotFoundError when CG returns no entry for the symbol", async () => {
      fetchStub.resolves(jsonResponse({}));
      try {
        await cg.getCurrentPriceBySymbol("UNKNOWN", "usd");
        expect.fail("Expected CoingeckoPriceNotFoundError");
      } catch (e) {
        expect(e).to.be.instanceOf(CoingeckoPriceNotFoundError);
        expect(isHttpError(e)).to.equal(false);
        const err = e as CoingeckoPriceNotFoundError;
        expect(err.identifier).to.equal("UNKNOWN");
        expect(err.currency).to.equal("usd");
        expect(err.lookupType).to.equal("symbol");
        expect(err.message).to.include("UNKNOWN");
        expect(err.message).to.include("usd");
      }
    });

    it("throws CoingeckoPriceNotFoundError when CG omits the requested currency", async () => {
      // CG has the token, just not in the requested vs_currency.
      fetchStub.resolves(jsonResponse({ usdc: { eth: 0.0003, last_updated_at: msToS(Date.now()) } }));
      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected CoingeckoPriceNotFoundError");
      } catch (e) {
        expect(e).to.be.instanceOf(CoingeckoPriceNotFoundError);
        expect(isHttpError(e)).to.equal(false);
      }
    });

    it("propagates HttpError on CG 5xx — NOT CoingeckoPriceNotFoundError", async () => {
      fetchStub.resolves(new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected HttpError");
      } catch (e) {
        expect(e).to.be.instanceOf(HttpError);
        expect(e).to.not.be.instanceOf(CoingeckoPriceNotFoundError);
        expect(isHttpError(e)).to.equal(true);
        expect((e as HttpError).status).to.equal(500);
      }
    });

    it("propagates HttpError on CG 429 (rate limit) — NOT CoingeckoPriceNotFoundError", async () => {
      fetchStub.resolves(new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }));
      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected HttpError");
      } catch (e) {
        expect(e).to.be.instanceOf(HttpError);
        expect(e).to.not.be.instanceOf(CoingeckoPriceNotFoundError);
        expect((e as HttpError).status).to.equal(429);
      }
    });

    it("propagates network failure (fetch rejects) — NOT CoingeckoPriceNotFoundError", async () => {
      const networkErr = new Error("ENOTFOUND test.example");
      fetchStub.rejects(networkErr);
      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected fetch rejection to propagate");
      } catch (e) {
        expect(e).to.equal(networkErr);
        expect(e).to.not.be.instanceOf(CoingeckoPriceNotFoundError);
      }
    });

    it("propagates a parse error on a non-JSON CG response — NOT CoingeckoPriceNotFoundError", async () => {
      fetchStub.resolves(
        new Response("<html>upstream proxy error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
      try {
        await cg.getCurrentPriceBySymbol("USDC", "usd");
        expect.fail("Expected a non-JSON parse error");
      } catch (e) {
        expect(e).to.be.instanceOf(Error);
        expect(e).to.not.be.instanceOf(CoingeckoPriceNotFoundError);
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
