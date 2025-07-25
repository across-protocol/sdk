import { BigNumber, parseEther, parseUnits, toWei, toGWei, toBN, biMin, biMax } from "../src/utils/BigNumberUtils";
import { expect } from "./utils";

describe("BigNumberUtils", () => {
  describe("biMin", () => {
    it("should return the smaller of two bigints", () => {
      expect(biMin(5n, 3n)).to.equal(3n);
      expect(biMin(3n, 5n)).to.equal(3n);
    });

    it("should return the same value when both bigints are equal", () => {
      expect(biMin(7n, 7n)).to.equal(7n);
    });

    it("should handle negative bigints correctly", () => {
      expect(biMin(-5n, -3n)).to.equal(-5n);
      expect(biMin(-3n, 2n)).to.equal(-3n);
    });

    it("should handle zero correctly", () => {
      expect(biMin(0n, 5n)).to.equal(0n);
      expect(biMin(-1n, 0n)).to.equal(-1n);
    });
  });

  describe("biMax", () => {
    it("should return the larger of two bigints", () => {
      expect(biMax(5n, 3n)).to.equal(5n);
      expect(biMax(3n, 5n)).to.equal(5n);
    });

    it("should return the same value when both bigints are equal", () => {
      expect(biMax(7n, 7n)).to.equal(7n);
    });

    it("should handle negative bigints correctly", () => {
      expect(biMax(-5n, -3n)).to.equal(-3n);
      expect(biMax(-3n, 2n)).to.equal(2n);
    });

    it("should handle zero correctly", () => {
      expect(biMax(0n, 5n)).to.equal(5n);
      expect(biMax(-1n, 0n)).to.equal(0n);
    });
  });

  describe("toWei", () => {
    it("should convert a stringified number to a BigNumber with 18 decimal places", () => {
      const num = "123.456";
      const expected = parseEther(num);
      const result = toWei(num);
      expect(result).to.be.deep.includes(expected);
    });
  });

  describe("toGWei", () => {
    it("should convert a stringified number to a BigNumber with 9 decimal places", () => {
      const num = "123.456";
      const expected = parseUnits(num, 9);
      const result = toGWei(num);
      expect(result).to.be.deep.includes(expected);
    });
  });

  describe("toBN", () => {
    it("should convert a stringified integer to a BigNumber", () => {
      const num = "123456";
      const expected = BigNumber.from(num);
      const result = toBN(num);
      expect(result).to.be.deep.includes(expected);
    });

    it("should convert a stringified number with decimal places to a BigNumber and round down by default", () => {
      const num = "123.456";
      const expected = BigNumber.from("123");
      const result = toBN(num);
      expect(result).to.be.deep.includes(expected);
    });

    it("should round up if rounding is set to 'ceil'", () => {
      const num = "123.456";
      const expected = BigNumber.from("124");
      const result = toBN(num, "ceil");
      expect(result).to.be.deep.includes(expected);
    });

    it("should round up if rounding is set to 'round' and the first decimal is greater than or equal to 5", () => {
      const num = "123.556";
      const expected = BigNumber.from("124");
      const result = toBN(num, "round");
      expect(result).to.be.deep.includes(expected);
    });
  });
});
