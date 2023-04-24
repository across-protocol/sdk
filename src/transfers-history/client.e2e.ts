import dotenv from "dotenv";
import { providers } from "ethers";
import { CHAIN_IDs } from "./adapters/web3/model";
import { TransfersHistoryClient, TransfersHistoryEvent } from "./client";

dotenv.config({ path: ".env" });

describe("Client e2e tests", () => {
  let client: TransfersHistoryClient;

  beforeAll(() => {
    client = new TransfersHistoryClient({
      pollingIntervalSeconds: 5,
      chains: [
        {
          chainId: CHAIN_IDs.MAINNET,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.MAINNET}`] || ""),
          spokePoolContractAddr: "0x4D9079Bb4165aeb4084c526a32695dCfd2F77381",
          lowerBoundBlockNumber: 14704425,
        },
        {
          chainId: CHAIN_IDs.OPTIMISM,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.OPTIMISM}`] || ""),
          spokePoolContractAddr: "0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9",
          lowerBoundBlockNumber: 6979967,
        },
        {
          chainId: CHAIN_IDs.ARBITRUM,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.ARBITRUM}`] || ""),
          spokePoolContractAddr: "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
          lowerBoundBlockNumber: 11102271,
        },
        {
          chainId: CHAIN_IDs.BOBA,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.BOBA}`] || ""),
          spokePoolContractAddr: "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58",
          lowerBoundBlockNumber: 551955,
        },
        {
          chainId: CHAIN_IDs.POLYGON,
          provider: new providers.JsonRpcProvider(process.env[`WEB3_NODE_URL_${CHAIN_IDs.POLYGON}`] || ""),
          spokePoolContractAddr: "0x69B5c72837769eF1e7C164Abc6515DcFf217F920",
          lowerBoundBlockNumber: 27875891,
        },
      ],
    });

    client.setLogLevel("debug");
  });

  it("should fetch pending transfers from chain", async (done) => {
    jest.setTimeout(1000 * 60);

    client.startFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
    client.on(TransfersHistoryEvent.TransfersUpdated, (data) => {
      console.log(data);
      const pendingTransfers = client.getPendingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      const filledTransfers = client.getFilledTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      const transfersWithSpeedUps = filledTransfers.filter(({ speedUps }) => speedUps.length) || [];
      client.stopFetchingTransfers("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      expect(pendingTransfers.length).toBeGreaterThanOrEqual(0);
      expect(filledTransfers.length).toBeGreaterThanOrEqual(0);
      expect(filledTransfers[0].fillTxs.length).toBeGreaterThanOrEqual(1);
      expect(transfersWithSpeedUps.length).toBeGreaterThan(0);

      done();
    });
  });

  it("should fetch all transfers", async (done) => {
    let iteration = 0;
    jest.setTimeout(1000 * 60);
    client.startFetchingTransfers("all");
    client.on(TransfersHistoryEvent.TransfersUpdated, () => {
      iteration++;
      const pendingTransfers = client.getPendingTransfers("all");
      const filledTransfers = client.getFilledTransfers("all");
      console.log({ pendingTransfers: pendingTransfers.length, filledTransfers: filledTransfers.length });
      expect(pendingTransfers.length).toBeGreaterThanOrEqual(0);
      expect(filledTransfers.length).toBeGreaterThanOrEqual(0);

      if (iteration === 3) {
        client.stopFetchingTransfers("all");
        done();
      }
    });
  });
});
