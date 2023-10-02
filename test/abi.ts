import { getABI } from "../src/utils/abi";
import { assertPromiseError, expect } from "./utils";

describe("ABI Utils", () => {
  describe("getABI", async () => {
    it("Retrieve Multicall3 ABI", async () => {
      expect(await getABI("Multicall3"));
    });

    it("Correctly handles missing contracts", async () => {
      const contractName = "missing-contract";
      await assertPromiseError(
        getABI(contractName),
        `Unable to retrieve ${contractName} ABI`
      );
    });
  });
});
