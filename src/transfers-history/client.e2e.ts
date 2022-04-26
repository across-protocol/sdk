import dotenv from "dotenv";
import { providers } from "ethers";
import { CHAIN_IDs } from "./adapters/web3/model";
import { TransfersHistoryClient, TransfersHistoryEvent } from "./client";

dotenv.config({ path: ".env" });

describe("Client e2e tests", () => {
  it("should fetch pending transfers from chain", async done => {
    jest.setTimeout(120 * 1000);
    const client = new TransfersHistoryClient({
      pollingIntervalSeconds: 0,
      chains: [
        {
          chainId: CHAIN_IDs.ARBITRUM_RINKEBY,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.ARBITRUM_RINKEBY}`] || ""),
          spokePoolContractAddr: "0x3BED21dAe767e4Df894B31b14aD32369cE4bad8b",
          lowerBoundBlockNumber: 10523275,
        },
        {
          chainId: CHAIN_IDs.OPTIMISM_KOVAN,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.OPTIMISM_KOVAN}`] || ""),
          spokePoolContractAddr: "0x2b7b7bAE341089103dD22fa4e8D7E4FA63E11084",
          lowerBoundBlockNumber: 1618630,
        },
        {
          chainId: CHAIN_IDs.KOVAN,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.KOVAN}`] || ""),
          spokePoolContractAddr: "0x73549B5639B04090033c1E77a22eE9Aa44C2eBa0",
          lowerBoundBlockNumber: 30475937,
        },
        {
          chainId: CHAIN_IDs.RINKEBY,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.RINKEBY}`] || ""),
          spokePoolContractAddr: "0xB078bBb35f8E24c2431b9d2a88C0bC0c26CC1F92",
          lowerBoundBlockNumber: 10485193,
        },
      ],
    });
    client.setLogLevel("debug");
    await client.startFetchingTransfers("0x718648C8c531F91b528A7757dD2bE813c3940608");
    client.on(TransfersHistoryEvent.TransfersUpdated, () => {
      const pendingTransfers = client.getPendingTransfers("0x718648C8c531F91b528A7757dD2bE813c3940608", 10, 0);
      const filledTransfers = client.getFilledTransfers("0x718648C8c531F91b528A7757dD2bE813c3940608", 10, 0);
      client.stopFetchingTransfers("0x718648C8c531F91b528A7757dD2bE813c3940608");
      expect(pendingTransfers.length).toBeGreaterThan(0);
      expect(filledTransfers.length).toBeGreaterThan(0);
      done();
    });
  });
});
