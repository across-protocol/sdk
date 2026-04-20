import { number, object, string } from "superstruct";
import { attempt, retry, toBNWei } from "../src/utils/common";
import { BigNumber, parseUnits } from "../src/utils/BigNumberUtils";
import { expect, sinon } from "./utils";

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => {
      return () =>
        new Promise<boolean>((resolve, reject) => {
          if (numFails-- > 0) {
            reject(new Error("fail"));
          }
          resolve(true);
        });
    };
    const results = await Promise.all([
      retry(failN(0), { retries: 0, delaySeconds: 0 }),
      retry(failN(1), { retries: 0, delaySeconds: 0 }),
      retry(failN(1), { retries: 1, delaySeconds: 0 }),
      retry(failN(2), { retries: 1, delaySeconds: 0 }),
      retry(failN(2), { retries: 2, delaySeconds: 0 }),
      retry(failN(3), { retries: 2, delaySeconds: 0 }),
    ]);
    expect(results.map((r) => r.ok)).to.deep.equal([true, false, true, false, true, false]);
  });

  describe("retry (options form)", () => {
    // Fails the first `numFails` invocations with the supplied error, then resolves.
    const makeFailingFn = (numFails: number, err: unknown = new Error("boom")) => {
      const spy = sinon.spy(() => {
        if (spy.callCount <= numFails) {
          return Promise.reject(err);
        }
        return Promise.resolve(true);
      });
      return spy;
    };

    it("retries up to `retries` times on retryable errors", async () => {
      const fn = makeFailingFn(2);
      const result = await retry(fn, { retries: 2, delaySeconds: 0 });
      expect(result.ok).to.be.true;
      expect(fn.callCount).to.equal(3);
    });

    it("uses default retries=2 when options are omitted", async () => {
      // Stub setTimeout so the test doesn't actually wait.
      const clock = sinon.stub(global, "setTimeout").callsFake(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);
      try {
        const fn = makeFailingFn(5);
        const result = await retry(fn);
        expect(result.ok).to.be.false;
        // 2 retries after initial = 3 total attempts.
        expect(fn.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    });

    it("exhausts retries and surfaces failure when failures outlast the budget", async () => {
      const fn = makeFailingFn(3);
      const result = await retry(fn, { retries: 2, delaySeconds: 0 });
      expect(result.ok).to.be.false;
      expect(fn.callCount).to.equal(3);
    });

    it("stops immediately when isRetryable returns false", async () => {
      const fn = makeFailingFn(5, new Error("non-retryable"));
      const isRetryable = sinon.spy((err: unknown) => (err as Error).message !== "non-retryable");
      const result = await retry(fn, { retries: 5, delaySeconds: 0, isRetryable });
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error.message).to.equal("non-retryable");
      }
      expect(fn.callCount).to.equal(1);
      expect(isRetryable.callCount).to.equal(1);
    });

    it("retries only errors matching isRetryable", async () => {
      const fn = sinon.spy(() => {
        if (fn.callCount === 1) return Promise.reject(new Error("transient"));
        if (fn.callCount === 2) return Promise.reject(new Error("fatal"));
        return Promise.resolve(true);
      });
      const isRetryable = (err: unknown) => (err as Error).message === "transient";
      const result = await retry(fn, { retries: 3, delaySeconds: 0, isRetryable });
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error.message).to.equal("fatal");
      }
      // First call threw "transient" → retried; second call threw "fatal" → stopped.
      expect(fn.callCount).to.equal(2);
    });

    it("wraps non-Error throws in an Error", async () => {
      const fn = sinon.spy(() => Promise.reject("string-throw"));
      const result = await retry(fn, { retries: 0, delaySeconds: 0 });
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error).to.be.instanceOf(Error);
        expect(result.error.message).to.equal("string-throw");
      }
    });

    it("uses exponential backoff by default", async () => {
      // Stub setTimeout to capture the waits without actually delaying.
      const timeouts: number[] = [];
      const clock = sinon.stub(global, "setTimeout").callsFake(((fn: () => void, ms: number) => {
        timeouts.push(ms);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

      try {
        const fn = makeFailingFn(2);
        await retry(fn, { retries: 2, delaySeconds: 1 });
        // Expect two waits, each ~= delaySeconds * 2^attempt + jitter, in milliseconds.
        // attempt=0 → (1 + [0,1)) s → [1000, 2000) ms
        // attempt=1 → (2 + [0,1)) s → [2000, 3000) ms
        expect(timeouts).to.have.length(2);
        expect(timeouts[0]).to.be.at.least(1000).and.below(2000);
        expect(timeouts[1]).to.be.at.least(2000).and.below(3000);
      } finally {
        clock.restore();
      }
    });

    it("runs schema validation on each attempt and retries structural failures", async () => {
      const Shape = object({ wdQuota: number(), usedWdQuota: number() });
      // First call returns a malformed payload; second returns a valid one.
      const fn = sinon.spy(() => {
        if (fn.callCount === 1) return Promise.resolve({ wdQuota: "wrong-type", usedWdQuota: 0 });
        return Promise.resolve({ wdQuota: 100, usedWdQuota: 10 });
      });
      const result = await retry(fn, { retries: 2, delaySeconds: 0, schema: Shape });
      expect(result.ok).to.be.true;
      if (result.ok) {
        expect(result.value).to.deep.equal({ wdQuota: 100, usedWdQuota: 10 });
      }
      expect(fn.callCount).to.equal(2);
    });
  });

  describe("attempt", () => {
    it("returns ok:true with the raw value when no schema is supplied", async () => {
      const result = await attempt(() => Promise.resolve(42));
      expect(result.ok).to.be.true;
      if (result.ok) {
        expect(result.value).to.equal(42);
      }
    });

    it("catches throws into ok:false without retrying", async () => {
      const fn = sinon.spy(() => Promise.reject(new Error("boom")));
      const result = await attempt(fn);
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error.message).to.equal("boom");
      }
      expect(fn.callCount).to.equal(1);
    });

    it("validates the value with schema and narrows the returned type", async () => {
      const Shape = object({ name: string() });
      const result = await attempt(() => Promise.resolve({ name: "binance" }), { schema: Shape });
      expect(result.ok).to.be.true;
      if (result.ok) {
        // result.value is typed as { name: string } — the .length check would be a compile
        // error without schema-driven narrowing.
        expect(result.value.name).to.equal("binance");
      }
    });

    it("surfaces schema mismatches as ok:false", async () => {
      const Shape = object({ name: string() });
      const result = await attempt(() => Promise.resolve({ name: 123 }), { schema: Shape });
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error).to.be.instanceOf(Error);
      }
    });

    it("wraps non-Error throws in an Error", async () => {
      const result = await attempt(() => Promise.reject("string-throw"));
      expect(result.ok).to.be.false;
      if (!result.ok) {
        expect(result.error).to.be.instanceOf(Error);
        expect(result.error.message).to.equal("string-throw");
      }
    });
  });

  describe("toBNWei", () => {
    describe("basic inputs", () => {
      it("should convert a string integer to BigNumber with default 18 decimals", () => {
        const result = toBNWei("1");
        const expected = parseUnits("1", 18);
        expect(result).to.deep.equal(expected);
      });

      it("should convert a string decimal to BigNumber with default 18 decimals", () => {
        const result = toBNWei("1.5");
        const expected = parseUnits("1.5", 18);
        expect(result).to.deep.equal(expected);
      });

      it("should convert a number to BigNumber with default 18 decimals", () => {
        const result = toBNWei(42);
        const expected = parseUnits("42", 18);
        expect(result).to.deep.equal(expected);
      });

      it("should handle custom decimals", () => {
        const result = toBNWei("1", 6);
        const expected = parseUnits("1", 6);
        expect(result).to.deep.equal(expected);
      });

      it("should handle BigNumber input", () => {
        const input = BigNumber.from("1000000000000000000");
        const result = toBNWei(input);
        // BigNumber.toString() returns "1000000000000000000", which parseUnits treats as 1e18 * 1e18
        const expected = parseUnits("1000000000000000000", 18);
        expect(result).to.deep.equal(expected);
      });
    });

    describe("scientific notation handling", () => {
      it("should handle positive exponent scientific notation (1e18)", () => {
        // 1e18 as a number converts to "1e+18" string
        const result = toBNWei(1e18, 0);
        const expected = BigNumber.from("1000000000000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle large positive exponent (1e21)", () => {
        const result = toBNWei(1e21, 0);
        const expected = BigNumber.from("1000000000000000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle scientific notation string with positive exponent", () => {
        const result = toBNWei("5e10", 0);
        const expected = BigNumber.from("50000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle scientific notation with decimals parameter", () => {
        // 1e6 with 6 decimals = 1e6 * 1e6 = 1e12
        const result = toBNWei(1e6, 6);
        const expected = BigNumber.from("1000000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle uppercase E notation", () => {
        const result = toBNWei("2.5E10", 0);
        const expected = BigNumber.from("25000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle negative coefficient with scientific notation", () => {
        // Note: toBNWei typically deals with positive amounts, but the function should handle this
        const result = toBNWei("-1e18", 0);
        const expected = BigNumber.from("-1000000000000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle fractional scientific notation (2.5e3)", () => {
        const result = toBNWei(2.5e3, 0);
        const expected = BigNumber.from("2500");
        expect(result).to.deep.equal(expected);
      });

      it("should handle very large numbers that JavaScript represents in scientific notation", () => {
        // Numbers larger than Number.MAX_SAFE_INTEGER are automatically in scientific notation
        const result = toBNWei(1e20, 0);
        const expected = BigNumber.from("100000000000000000000");
        expect(result).to.deep.equal(expected);
      });

      it("should handle negative exponent scientific notation (1e-18)", () => {
        const result = toBNWei(1e-18);
        const expected = BigNumber.from("1");
        expect(result).to.deep.equal(expected);
      });
    });

    describe("edge cases", () => {
      it("should handle zero", () => {
        const result = toBNWei("0");
        const expected = BigNumber.from("0");
        expect(result).to.deep.equal(expected);
      });

      it("should handle zero with decimals", () => {
        const result = toBNWei("0", 6);
        const expected = BigNumber.from("0");
        expect(result).to.deep.equal(expected);
      });

      it("should handle small decimal values", () => {
        const result = toBNWei("0.000000000000000001", 18);
        const expected = BigNumber.from("1");
        expect(result).to.deep.equal(expected);
      });

      it("should handle values that result in 1 wei", () => {
        const result = toBNWei("0.000001", 6);
        const expected = BigNumber.from("1");
        expect(result).to.deep.equal(expected);
      });
    });
  });
});
