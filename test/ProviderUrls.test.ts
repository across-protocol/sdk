import { CHAIN_IDs } from "../src/constants";
import { getURL } from "../src/providers/quicknode";
import { expect } from "./utils";

describe("Provider URL generation", () => {
  describe("quicknode.getURL", () => {
    const envVar = "RPC_PROVIDER_KEY_QUICKNODE_PREFIX";
    const prefix = "test-prefix";
    const apiKey = "test-key";
    let previous: string | undefined;

    before(() => {
      previous = process.env[envVar];
      process.env[envVar] = prefix;
    });

    after(() => {
      if (previous === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previous;
      }
    });

    it("appends the Avalanche C-Chain path", () => {
      expect(getURL(CHAIN_IDs.AVALANCHE, apiKey, "https")).to.equal(
        `https://${prefix}.avalanche-mainnet.quiknode.pro/${apiKey}/ext/bc/C/rpc`
      );
      expect(getURL(CHAIN_IDs.AVALANCHE, apiKey, "wss")).to.equal(
        `wss://${prefix}.avalanche-mainnet.quiknode.pro/${apiKey}/ext/bc/C/ws`
      );
    });

    it("does not append a path for chains without one", () => {
      expect(getURL(CHAIN_IDs.MAINNET, apiKey, "https")).to.equal(`https://${prefix}.quiknode.pro/${apiKey}`);
      expect(getURL(CHAIN_IDs.OPTIMISM, apiKey, "https")).to.equal(`https://${prefix}.optimism.quiknode.pro/${apiKey}`);
    });
  });
});
