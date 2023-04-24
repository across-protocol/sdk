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

type FeeData = providers.FeeData;

class MockedProvider extends providers.JsonRpcProvider {
  // Unknown type => exercise our validation logic
  public testFeeData: unknown;
  public testGasPrice: unknown;

  constructor(url: string) {
    super(url);
  }

  override async getFeeData(): Promise<FeeData> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.testFeeData as any) ?? (await super.getFeeData());
  }

  override async getGasPrice(): Promise<BigNumber> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.testGasPrice !== undefined ? (this.testGasPrice as any) : await super.getGasPrice();
  }
}

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

const stdGasPrice = BigNumber.from(10);
const stdMaxPriorityFeePerGas = BigNumber.from(2); // EIP-1559 chains only
const stdMaxFeePerGas = stdGasPrice.add(stdMaxPriorityFeePerGas);
const eip1559Chains = [1, 137];
const legacyChains = [10, 288, 42161];

let providerInstances: { [chainId: number]: MockedProvider } = {};

describe("Gas Price Oracle", function () {
  beforeAll(() => {
    providerInstances = Object.fromEntries(
      Object.entries(networks).map(([_chainId, _rpcUrl]) => {
        const chainId = Number(_chainId);
        const rpcUrl: string = process.env[`NODE_URL_${chainId}`] ?? _rpcUrl;
        const provider = new MockedProvider(rpcUrl);
        return [chainId, provider];
      })
    );
  });

  beforeEach(() => {
    for (const provider of Object.values(providerInstances)) {
      provider.testFeeData = {
        gasPrice: stdGasPrice,
        maxFeePerGas: stdMaxFeePerGas,
        maxPriorityFeePerGas: stdMaxPriorityFeePerGas,
      };
      provider.testGasPrice = stdGasPrice; // Required: same as provider.feeData.gasPrice.
    }
  });

  test("Gas Price Retrieval", async function () {
    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      const chainId = Number(_chainId);

      const gasPrice: GasPriceEstimate = await getGasPriceEstimate(provider);
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Retrieval",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        gasPrice,
      });

      assert.ok(gasPrice);
      assert.ok(BigNumber.isBigNumber(gasPrice.maxFeePerGas));

      if (eip1559Chains.includes(chainId)) {
        assert.ok(gasPrice.maxFeePerGas.eq(stdMaxFeePerGas), `${gasPrice.maxFeePerGas} != ${stdMaxFeePerGas}`);
        assert.ok(BigNumber.isBigNumber(gasPrice.maxPriorityFeePerGas));
        assert.ok(
          gasPrice.maxPriorityFeePerGas.eq(stdMaxPriorityFeePerGas),
          `${gasPrice.maxPriorityFeePerGas} != ${stdMaxPriorityFeePerGas}`
        );
      } else {
        // Defaults to Legacy (Type 0)
        assert.ok(gasPrice.maxFeePerGas.eq(stdGasPrice), `${gasPrice.maxFeePerGas} != ${stdGasPrice}`);
        assert.ok(gasPrice.maxPriorityFeePerGas.eq(0));
      }
    }
  }, 10000);

  test("Gas Price Retrieval Failure", async function () {
    const feeDataFields = ["gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"];
    const feeDataValues = [null, "test", "1234", 5678, BigNumber.from(-1)];

    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      const chainId = Number(_chainId);

      // Iterate over various faulty values for gasPrice & feeData.
      for (const field of feeDataFields) {
        for (const value of feeDataValues) {
          provider.testGasPrice = field === "gasPrice" ? value : stdGasPrice;
          provider.testFeeData = {
            gasPrice: field === "gasPrice" ? value : stdGasPrice,
            maxFeePerGas: field === "gasPrice" ? value : stdMaxFeePerGas, // nb. use "lastBaseFeePerGas"
            maxPriorityFeePerGas: field === "maxPriorityFeePerGas" ? value : stdMaxPriorityFeePerGas,
          };

          if (
            // Malformed inputs were supplied; ensure an exception is thrown.
            (eip1559Chains.includes(chainId) && ["gasPrice", "maxPriorityFeePerGas"].includes(field)) ||
            (legacyChains.includes(chainId) && ["gasPrice"].includes(field))
          ) {
            await expect(getGasPriceEstimate(provider)).rejects.toThrow();
          } else {
            // Expect sane results to be returned; validate them.
            const gasPrice: GasPriceEstimate = await getGasPriceEstimate(provider);

            dummyLogger.debug({
              at: "Gas Price Oracle#Gas Price Retrieval",
              message: `Retrieved gas price estimate for chain ID ${chainId}.`,
              gasPrice,
            });

            assert.ok(gasPrice);
            assert(BigNumber.isBigNumber(gasPrice.maxFeePerGas));
            assert(BigNumber.isBigNumber(gasPrice.maxPriorityFeePerGas));

            if (eip1559Chains.includes(chainId)) {
              assert(gasPrice.maxFeePerGas.eq(stdMaxFeePerGas));
              assert(gasPrice.maxPriorityFeePerGas.eq(stdMaxPriorityFeePerGas));
            } else {
              // Legacy
              assert(gasPrice.maxFeePerGas.eq(stdGasPrice));
              assert(gasPrice.maxPriorityFeePerGas.eq(0));
            }
          }
        }
      }
    }
  }, 25000);

  test("Gas Price Fallback Behaviour", async function () {
    for (const provider of Object.values(providerInstances)) {
      const fakeChainId = 1337;
      provider.testGasPrice = stdMaxFeePerGas; // Suppress RPC lookup.

      const gasPrice: GasPriceEstimate = await getGasPriceEstimate(provider, fakeChainId, true);
      assert.ok(gasPrice);

      // Require legacy pricing when fallback is permitted.
      assert.ok(BigNumber.isBigNumber(gasPrice.maxFeePerGas));
      assert.ok(gasPrice.maxFeePerGas.eq(stdMaxFeePerGas));

      assert.ok(BigNumber.isBigNumber(gasPrice.maxPriorityFeePerGas));
      assert.ok(gasPrice.maxPriorityFeePerGas.eq(0));

      // Verify an assertion is thrown when fallback is not permitted.
      await expect(getGasPriceEstimate(provider, fakeChainId, false)).rejects.toThrow();
    }
  });
});
