// Note: to run this test, you will need node urls for 3 chains to be provided in the ENV:
// NODE_URL_42161
// NODE_URL_288
// NODE_URL_10
// NODE_URL_1
// NODE_URL_137

import dotenv from "dotenv";

import { ArbitrumQueries } from "./arbitrum";

import { providers } from "ethers";
import { BobaQueries } from "./boba";
import { EthereumQueries } from "./ethereum";
import { OptimismQueries } from "./optimism";
import { PolygonQueries } from "./polygon";

dotenv.config();

describe("Queries", function () {
  test("Arbitrum", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_42161);
    const arbitrumQueries = new ArbitrumQueries(provider);
    await Promise.all([
      arbitrumQueries.getGasCosts("USDC"),
      arbitrumQueries.getTokenDecimals("USDC"),
      arbitrumQueries.getTokenPrice("USDC"),
    ]);
  });
  test("Boba", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_288);
    const bobaQueries = new BobaQueries(provider);
    await Promise.all([
      bobaQueries.getGasCosts("USDC"),
      bobaQueries.getTokenDecimals("USDC"),
      bobaQueries.getTokenPrice("USDC"),
    ]);
  });
  test("Ethereum", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_1);
    const ethereumQueries = new EthereumQueries(provider);
    await Promise.all([
      ethereumQueries.getGasCosts("USDC"),
      ethereumQueries.getTokenDecimals("USDC"),
      ethereumQueries.getTokenPrice("USDC"),
    ]);
  });
  test("Optimism", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_10);
    const optimismQueries = new OptimismQueries(provider);
    await Promise.all([
      optimismQueries.getGasCosts("USDC"),
      optimismQueries.getTokenDecimals("USDC"),
      optimismQueries.getTokenPrice("USDC"),
    ]);
  });
  test("Polygon", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_137);
    const polygonQueries = new PolygonQueries(provider);
    await Promise.all([
      polygonQueries.getGasCosts("USDC"),
      polygonQueries.getTokenDecimals("USDC"),
      polygonQueries.getTokenPrice("USDC"),
    ]);
  });
});
