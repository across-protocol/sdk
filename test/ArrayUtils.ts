import { chunk } from "../src/utils/ArrayUtils";
import { expect } from "./utils";

describe("ArrayUtils", () => {
  describe("chunk", () => {
    it("Applies the requested chunk size", () => {
      const chunkSize = 10;
      const array = Array.from({ length: 999 }, (_, idx) => idx);

      const chunkedArray = chunk(array, chunkSize);
      expect(chunkedArray.length).to.equal(Math.ceil(array.length / chunkSize));
      expect(chunkedArray.at(-1)?.length).to.equal(9);
    });
  });

});
