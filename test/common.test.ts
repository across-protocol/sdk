import assert from "assert";

import { retry, toBNWei } from "../src/utils/common";
import { BigNumber, parseUnits } from "../src/utils/BigNumberUtils";
import { expect } from "./utils";

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => {
      return () =>
        new Promise((resolve, reject) => {
          if (numFails-- > 0) {
            reject();
          }
          resolve(true);
        });
    };
    await Promise.all([
      assert.doesNotReject(() => retry(failN(0), 0, 1)),
      assert.rejects(() => retry(failN(1), 0, 1)),
      assert.doesNotReject(() => retry(failN(1), 1, 1)),
      assert.rejects(() => retry(failN(2), 1, 1)),
      assert.doesNotReject(() => retry(failN(2), 2, 1)),
      assert.rejects(() => retry(failN(3), 2, 1)),
    ]);
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
