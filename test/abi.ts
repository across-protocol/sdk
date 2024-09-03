import * as fs from "fs/promises";
import { getABI, getABIDir } from "../src/utils/abi";
import { assertPromiseError, assertPromisePasses } from "./utils";

describe("ABI Utils", () => {
  describe("getABI", () => {
    it("All files are valid JSON", async () => {
      let abiFiles = await fs.readdir(getABIDir(), { encoding: "utf8" });

      // Filter out any dotfiles, because editors sometimes save them in the local working directory. Also, strip any
      // trailing '.json', since readdir() returns the full filename, but callers should only supply the ABI name.
      abiFiles = abiFiles
        .filter((fileName) => !fileName.startsWith("."))
        // filter out barrel file
        .filter((fileName) => !(fileName === "index.ts"))
        .map((fileName) => fileName.slice(0, fileName.lastIndexOf(".json")));

      for (const abiFile of abiFiles) {
        await assertPromisePasses(getABI(abiFile));
      }
    });

    it("Correctly handles missing contracts", async () => {
      const contractName = "missing-contract";
      await assertPromiseError(getABI(contractName), `Unable to retrieve ${contractName} ABI`);
    });
  });
});
