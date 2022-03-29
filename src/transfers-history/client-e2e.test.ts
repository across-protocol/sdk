import dotenv from "dotenv";
import { CHAIN_IDs } from "./adapters/web3/model";
import { TransfersHistoryClient, TransfersHistoryEvent } from "./client";

dotenv.config({ path: ".env" });

const wait = (seconds: number) => {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, seconds * 1000);
  });
};

describe.only("Client e2e tests", () => {
  it("should fetch pending transfers from chain", async () => {
    jest.setTimeout(60 * 1000);
    const client = new TransfersHistoryClient({
      chains: [
        {
          chainId: CHAIN_IDs.ARBITRUM_RINKEBY,
          providerUrl: process.env[`WEB3_NODE_URL_${CHAIN_IDs.ARBITRUM_RINKEBY}`] || "",
        },
        {
          chainId: CHAIN_IDs.OPTIMISM_KOVAN,
          providerUrl: process.env[`WEB3_NODE_URL_${CHAIN_IDs.OPTIMISM_KOVAN}`] || "",
        },
      ],
    });
    client.setLogLevel("debug");
    await client.startFetchingTransfers("0x9B6134Fe036F1C22D9Fe76c15AC81B7bC31212eB");
    await wait(15);
    const transfers = client.getPendingTransfers("0x9B6134Fe036F1C22D9Fe76c15AC81B7bC31212eB");
    client.stopFetchingTransfers("0x9B6134Fe036F1C22D9Fe76c15AC81B7bC31212eB");
    expect(transfers.length).toBeGreaterThan(0);
  });
});
