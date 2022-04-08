import dotenv from "dotenv";
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
          providerUrl: process.env[`WEB3_NODE_URL_${CHAIN_IDs.ARBITRUM_RINKEBY}`] || "",
          spokePoolContractAddr: "0x3BED21dAe767e4Df894B31b14aD32369cE4bad8b",
          lowerBoundBlockNumber: 10523275,
        },
        {
          chainId: CHAIN_IDs.OPTIMISM_KOVAN,
          providerUrl: process.env[`WEB3_NODE_URL_${CHAIN_IDs.OPTIMISM_KOVAN}`] || "",
          spokePoolContractAddr: "0x2b7b7bAE341089103dD22fa4e8D7E4FA63E11084",
          lowerBoundBlockNumber: 1618630,
        },
        {
          chainId: CHAIN_IDs.KOVAN,
          providerUrl: process.env[`WEB3_NODE_URL_${CHAIN_IDs.KOVAN}`] || "",
          spokePoolContractAddr: "0x73549B5639B04090033c1E77a22eE9Aa44C2eBa0",
          lowerBoundBlockNumber: 30475937,
        },
      ],
    });
    client.setLogLevel("debug");
    await client.startFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
    client.on(TransfersHistoryEvent.TransfersUpdated, () => {
      const pendingTransfers = client.getPendingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D", 30, 0);
      client.stopFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      expect(pendingTransfers.length).toBeGreaterThan(0);
      done();
    });
  });
});
