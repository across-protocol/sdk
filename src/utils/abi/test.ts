import { getABI } from "./";

describe("ABI Utils", () => {
  describe("getABI", () => {
    it("Retrieve Multicall3 ABI", async () => {
      expect(await getABI("Multicall3"));
    });

    it("Correctly handles missing contracts", async () => {
      const contractName = "missing-contract";
      await expect(getABI(contractName)).rejects.toThrow(`Unable to retrieve ${contractName} ABI (ENOENT)`);
    });
  });
});
