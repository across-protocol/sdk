import { ArbitrumQueries } from "../src/relayFeeCalculator/chain-queries/arbitrum";
import { providers } from "ethers";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";
import { BobaQueries } from "../src/relayFeeCalculator/chain-queries/boba";
import { EthereumQueries } from "../src/relayFeeCalculator/chain-queries/ethereum";
import { OptimismQueries } from "../src/relayFeeCalculator/chain-queries/optimism";
import { PolygonQueries } from "../src/relayFeeCalculator/chain-queries/polygon";
import { loadEnv } from "./utils";

loadEnv();

describe("Queries", function () {
  it("Arbitrum", async function () {
    const provider = new providers.JsonRpcProvider(
      process.env.NODE_URL_42161 ?? PUBLIC_NETWORKS[CHAIN_IDs.ARBITRUM].publicRPC
    );
    const arbitrumQueries = new ArbitrumQueries(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env.COINGECKO_PRO_API_KEY
    );
    await Promise.all([arbitrumQueries.getGasCosts(), arbitrumQueries.getTokenPrice("USDC")]);
  });
  it("Boba", async function () {
    const provider = new providers.JsonRpcProvider(
      process.env.NODE_URL_288 ?? PUBLIC_NETWORKS[CHAIN_IDs.BOBA].publicRPC
    );
    const bobaQueries = new BobaQueries(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env.COINGECKO_PRO_API_KEY
    );
    await Promise.all([bobaQueries.getGasCosts(), bobaQueries.getTokenPrice("USDC")]);
  });
  it("Ethereum", async function () {
    const provider = new providers.JsonRpcProvider(
      process.env.NODE_URL_1 ?? PUBLIC_NETWORKS[CHAIN_IDs.MAINNET].publicRPC
    );
    const ethereumQueries = new EthereumQueries(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env.COINGECKO_PRO_API_KEY
    );
    await Promise.all([ethereumQueries.getGasCosts(), ethereumQueries.getTokenPrice("USDC")]);
  });
  it("Optimism", async function () {
    const provider = new providers.JsonRpcProvider(
      process.env.NODE_URL_10 ?? PUBLIC_NETWORKS[CHAIN_IDs.OPTIMISM].publicRPC
    );
    const optimismQueries = new OptimismQueries(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env.COINGECKO_PRO_API_KEY
    );
    await Promise.all([optimismQueries.getGasCosts(), optimismQueries.getTokenPrice("USDC")]);
  });
  it("Polygon", async function () {
    const provider = new providers.JsonRpcProvider(
      process.env.NODE_URL_137 ?? PUBLIC_NETWORKS[CHAIN_IDs.POLYGON].publicRPC
    );
    const polygonQueries = new PolygonQueries(
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env.COINGECKO_PRO_API_KEY
    );
    await Promise.all([polygonQueries.getGasCosts(), polygonQueries.getTokenPrice("USDC")]);
  });
});
