import dotenv from "dotenv";
import { providers } from "ethers";
import { CHAIN_IDs } from "./adapters/web3/model";
import { TransfersHistoryClient, TransfersHistoryEvent } from "./client";

dotenv.config({ path: ".env" });

describe("Client e2e tests", () => {
  it("should fetch pending transfers from chain", async (done) => {
    jest.setTimeout(1000 * 60);
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
          spokePoolContractAddr: "0x1954D4A36ac4fD8BEde42E59368565A92290E705",
          lowerBoundBlockNumber: 1618630,
        },
        {
          chainId: CHAIN_IDs.KOVAN,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.KOVAN}`] || ""),
          spokePoolContractAddr: "0x90bab3160d417B4cd791Db5f8C4E79704e67bd49",
          lowerBoundBlockNumber: 30475937,
        },
        {
          chainId: CHAIN_IDs.RINKEBY,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.RINKEBY}`] || ""),
          spokePoolContractAddr: "0xB078bBb35f8E24c2431b9d2a88C0bC0c26CC1F92",
          lowerBoundBlockNumber: 10485193,
        },
        {
          chainId: CHAIN_IDs.MAINNET,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.MAINNET}`] || ""),
          spokePoolContractAddr: "0x931A43528779034ac9eb77df799d133557406176",
          lowerBoundBlockNumber: 14704425,
        },
        {
          chainId: CHAIN_IDs.OPTIMISM,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.OPTIMISM}`] || ""),
          spokePoolContractAddr: "0x59485d57EEcc4058F7831f46eE83a7078276b4AE",
          lowerBoundBlockNumber: 6979967,
        },
        {
          chainId: CHAIN_IDs.ARBITRUM,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.ARBITRUM}`] || ""),
          spokePoolContractAddr: "0xe1C367e2b576Ac421a9f46C9cC624935730c36aa",
          lowerBoundBlockNumber: 11102271,
        },
        {
          chainId: CHAIN_IDs.BOBA,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.BOBA}`] || ""),
          spokePoolContractAddr: "0x7229405a2f0c550Ce35182EE1658302B65672443",
          lowerBoundBlockNumber: 551955,
        },
        {
          chainId: CHAIN_IDs.POLYGON,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.POLYGON}`] || ""),
          spokePoolContractAddr: "0xD3ddAcAe5aFb00F9B9cD36EF0Ed7115d7f0b584c",
          lowerBoundBlockNumber: 27875891,
        },
      ],
    });

    client.setLogLevel("debug");
    await client.startFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
    client.on(TransfersHistoryEvent.TransfersUpdated, () => {
      const pendingTransfers = client.getPendingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      const filledTransfers = client.getFilledTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      client.stopFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      expect(pendingTransfers.length).toBeGreaterThanOrEqual(0);
      expect(filledTransfers.length).toBeGreaterThanOrEqual(0);
      expect(filledTransfers[0].fillTxs.length).toBeGreaterThanOrEqual(1);
      done();
    });
  });
});
