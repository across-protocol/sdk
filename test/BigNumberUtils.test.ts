import { BigNumber, parseEther, parseUnits, toWei, toGWei, toBN } from "../src/utils/BigNumberUtils";
import { expect } from "./utils";

describe("BigNumberUtils", () => {
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
