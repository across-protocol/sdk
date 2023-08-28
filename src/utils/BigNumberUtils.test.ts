import { ethers } from "ethers";
import { toWei, toGWei, toBN } from "./BigNumberUtils";

describe("BigNumberUtils", () => {
  describe("toWei", () => {
    it("should convert a stringified number to a BigNumber with 18 decimal places", () => {
      const num = "123.456";
      const expected = ethers.utils.parseEther(num);
      const result = toWei(num);
      expect(result).toEqual(expected);
    });
  });

  describe("toGWei", () => {
    it("should convert a stringified number to a BigNumber with 9 decimal places", () => {
      const num = "123.456";
      const expected = ethers.utils.parseUnits(num, 9);
      const result = toGWei(num);
      expect(result).toEqual(expected);
    });
  });

  describe("toBN", () => {
    it("should convert a stringified integer to a BigNumber", () => {
      const num = "123456";
      const expected = ethers.BigNumber.from(num);
      const result = toBN(num);
      expect(result).toEqual(expected);
    });

    it("should convert a stringified number with decimal places to a BigNumber and round down by default", () => {
      const num = "123.456";
      const expected = ethers.BigNumber.from("123");
      const result = toBN(num);
      expect(result).toEqual(expected);
    });

    it("should round up if rounding is set to 'ceil'", () => {
      const num = "123.456";
      const expected = ethers.BigNumber.from("124");
      const result = toBN(num, "ceil");
      expect(result).toEqual(expected);
    });

    it("should round up if rounding is set to 'round' and the first decimal is greater than or equal to 5", () => {
      const num = "123.556";
      const expected = ethers.BigNumber.from("124");
      const result = toBN(num, "round");
      expect(result).toEqual(expected);
    });
  });
});
