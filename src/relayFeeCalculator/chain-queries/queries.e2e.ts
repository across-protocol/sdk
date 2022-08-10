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
import { EthereumQueries, SymbolMapping } from "./ethereum";
import { OptimismQueries } from "./optimism";
import { PolygonQueries } from "./polygon";

dotenv.config();

describe("Queries", function () {
  test("Arbitrum", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_42161);
    const arbitrumQueries = new ArbitrumQueries(provider);
    await Promise.all([
      arbitrumQueries.getGasCosts(),
      arbitrumQueries.getTokenDecimals("USDC"),
      arbitrumQueries.getTokenPrice("USDC"),
    ]);
    const queriesWithCoingeckoProApi = new ArbitrumQueries(
      provider,
      SymbolMapping,
      "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      "0x893d0d70ad97717052e3aa8903d9615804167759",
      process.env.COINGECKO_PRO_API_KEY
    );
    await queriesWithCoingeckoProApi.getTokenPrice("USDC");
  });
  test("Boba", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_288);
    const bobaQueries = new BobaQueries(provider);
    await Promise.all([
      bobaQueries.getGasCosts(),
      bobaQueries.getTokenDecimals("USDC"),
      bobaQueries.getTokenPrice("USDC"),
    ]);
    const queriesWithCoingeckoProApi = new ArbitrumQueries(
      provider,
      SymbolMapping,
      "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58",
      "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
      "0x893d0d70ad97717052e3aa8903d9615804167759",
      process.env.COINGECKO_PRO_API_KEY
    );
    await queriesWithCoingeckoProApi.getTokenPrice("USDC");
  });
  test("Ethereum", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_1);
    const ethereumQueries = new EthereumQueries(provider);
    await Promise.all([
      ethereumQueries.getGasCosts(),
      ethereumQueries.getTokenDecimals("USDC"),
      ethereumQueries.getTokenPrice("USDC"),
    ]);
    const queriesWithCoingeckoProApi = new ArbitrumQueries(
      provider,
      SymbolMapping,
      "0x4D9079Bb4165aeb4084c526a32695dCfd2F77381",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0x893d0d70ad97717052e3aa8903d9615804167759",
      process.env.COINGECKO_PRO_API_KEY
    );
    await queriesWithCoingeckoProApi.getTokenPrice("USDC");
  });
  test("Optimism", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_10);
    const optimismQueries = new OptimismQueries(provider);
    await Promise.all([
      optimismQueries.getGasCosts(),
      optimismQueries.getTokenDecimals("USDC"),
      optimismQueries.getTokenPrice("USDC"),
    ]);
    const queriesWithCoingeckoProApi = new ArbitrumQueries(
      provider,
      SymbolMapping,
      "0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9",
      "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
      "0x893d0d70ad97717052e3aa8903d9615804167759",
      process.env.COINGECKO_PRO_API_KEY
    );
    await queriesWithCoingeckoProApi.getTokenPrice("USDC");
  });
  test("Polygon", async function () {
    const provider = new providers.JsonRpcProvider(process.env.NODE_URL_137);
    const polygonQueries = new PolygonQueries(provider);
    await Promise.all([
      polygonQueries.getGasCosts(),
      polygonQueries.getTokenDecimals("USDC"),
      polygonQueries.getTokenPrice("USDC"),
    ]);
    const queriesWithCoingeckoProApi = new ArbitrumQueries(
      provider,
      SymbolMapping,
      "0x69B5c72837769eF1e7C164Abc6515DcFf217F920",
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      "0x893d0d70ad97717052e3aa8903d9615804167759",
      process.env.COINGECKO_PRO_API_KEY
    );
    await queriesWithCoingeckoProApi.getTokenPrice("USDC");
  });
});
