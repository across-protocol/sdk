import assert from "assert";
import dotenv from "dotenv";
import winston from "winston";
import { BigNumber, providers } from "ethers";
import { GasPriceEstimate, getGasPriceEstimate } from "./oracle";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

/**
 * Note: If NODE_URL_<chainId> envvars exist, they will be used. The
 * RPCs defined below are otherwise used as default/fallback options.
 * These may be subject to rate-limiting, in which case the retrieved
 * price will revert to 0.
 *
 * Note also that Optimism is only supported as a fallback/legacy test
 * case. It works, but is not the recommended method for conjuring gas
 * prices on Optimism.
 */
const networks: { [chainId: number]: string } = {
  1: "https://rpc.ankr.com/eth",
  10: "https://rpc.ankr.com/optimism",
  137: "https://rpc.ankr.com/polygon",
  288: "https://lightning-replica.boba.network",
  42161: "https://rpc.ankr.com/arbitrum",
};

describe("Gas Price Oracle", function () {
  test("Gas Price Retrieval", async function () {
    jest.setTimeout(15000); // Default timeout (5s) typically too short.

    for (const chainId of Object.keys(networks)) {
      const envNode = `NODE_URL_${chainId}`;
      const rpcUrl: string = process.env[envNode] ?? networks[Number(chainId)];
      const provider = new providers.JsonRpcProvider(rpcUrl);

      const gasPrice: GasPriceEstimate = await getGasPriceEstimate(provider);
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Retrieval",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        gasPrice,
      });

      assert.ok(gasPrice);
      assert.ok(BigNumber.isBigNumber(gasPrice.maxFeePerGas));
      assert.ok(gasPrice.maxFeePerGas.gte(0));

      if ([1, 137].includes(Number(chainId))) {
        // EIP-1559 (Type 2)
        assert.ok(BigNumber.isBigNumber(gasPrice.maxPriorityFeePerGas));
        assert.ok(gasPrice.maxPriorityFeePerGas.gte(0));
      } else {
        // Legacy (Type 0)
        assert.ok(gasPrice.maxPriorityFeePerGas === undefined);
      }
    }
  });
});
