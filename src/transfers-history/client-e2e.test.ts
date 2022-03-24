import dotenv from "dotenv";
import { ChainId } from "../constants";
import { TransfersHistoryClient } from "./client";

dotenv.config({ path: ".env" });

describe("Client E2E tests", () => {
  it("should fetch pending transfers from chain", async () => {
    jest.setTimeout(60 * 1000);
    const client = new TransfersHistoryClient({
      chains: [
        {
          chainId: ChainId.ARBITRUM_RINKEBY,
          providerUrl: process.env[`WEB3_NODE_URL_${ChainId.ARBITRUM_RINKEBY}`] || "",
        },
      ],
      refChainId: ChainId.ARBITRUM_RINKEBY,
    });
    const transfers = await client.getTransfers({ status: "pending" }, 2, 0);
    expect(transfers.length).toBeGreaterThan(1);
  });

  it("should fetch pending transfers from chain until lower bound block is hit", async () => {
    jest.setTimeout(60 * 1000);
    const client = new TransfersHistoryClient({
      chains: [
        {
          chainId: ChainId.ARBITRUM_RINKEBY,
          providerUrl: process.env[`WEB3_NODE_URL_${ChainId.ARBITRUM_RINKEBY}`] || "",
        },
      ],
      refChainId: ChainId.ARBITRUM_RINKEBY,
    });
    const transfers = await client.getTransfers({ status: "pending" }, 2, 0);
    expect(transfers.length).toBeGreaterThan(1);
  });
});
