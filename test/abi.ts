import * as fs from "fs/promises";
import { getABI, getABIDir } from "../src/utils/abi";
import { assertPromiseError, expect } from "./utils";

describe("ABI Utils", () => {
  describe("getABI", () => {
    it("All files are valid JSON", async () => {
      const abiFiles = await fs.readdir(getABIDir(), { encoding: "utf8" });

      // Strip any trailing '.json', since readdir() returns the
      // full filename but callers should only supply the ABI name.
      for (const abiFile of abiFiles.map((abi) => abi.slice(0, abi.lastIndexOf(".json")))) {
        expect(await getABI(abiFile)).to.not.throw;
      }
    });

    it("Correctly handles missing contracts", async () => {
      const contractName = "missing-contract";
      await assertPromiseError(getABI(contractName), `Unable to retrieve ${contractName} ABI`);
    });
  });
});
