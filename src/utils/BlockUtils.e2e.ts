import { providers } from "ethers";
import { averageBlockTime } from "./BlockUtils";

type Provider = providers.Provider;

const networks: { [chainId: number]: string } = {
  1: "https://eth.llamarpc.com",
  10: "https://mainnet.optimism.io",
  137: "https://polygon.llamarpc.com",
  384: "https://mainnet.era.zksync.io",
  42161: "https://rpc.ankr.com/arbitrum",
};

describe("BlockUtils", () => {
  let rpcProviders: Provider[] = [];

  beforeAll(() => {
    rpcProviders = Object.entries(networks).map(([chainId, _rpcUrl]) => {
      const rpcUrl: string = process.env[`NODE_URL_${chainId}`] ?? _rpcUrl;
      const provider = new providers.StaticJsonRpcProvider(rpcUrl);
      return provider;
    });
  });

  it("Compute average block times", async () => {
    for (const provider of rpcProviders) {
      const chainId = (await provider.getNetwork()).chainId;

      const { average, blockRange } = await averageBlockTime(provider);
      console.log(`Got average block time over ${blockRange} blocks for chain ${chainId}: ${average}.`);
    }
  });
});
