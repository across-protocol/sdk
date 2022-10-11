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
  public feeData: any;
  public gasPrice: any;

  constructor(args: any) {
    super(args);
  }

  override async getFeeData(): Promise<FeeData> {
    return this.feeData ?? (await super.getFeeData());
  }

  override async getGasPrice(): Promise<BigNumber> {
    return this.gasPrice !== undefined ? this.gasPrice : await super.getGasPrice();
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

const stdMaxPriorityFeePerGas = BigNumber.from(2); // EIP-1559 chains only
const stdMaxFeePerGas = stdMaxPriorityFeePerGas.add(10);
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
    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      provider.feeData = {
        gasPrice: stdMaxFeePerGas,
        maxFeePerGas: stdMaxFeePerGas,
        maxPriorityFeePerGas: stdMaxPriorityFeePerGas,
      };
      provider.gasPrice = provider.feeData.gasPrice;
    }
  });

  test("Gas Price Retrieval", async function () {
    jest.setTimeout(10000);

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
      assert.ok(gasPrice.maxFeePerGas.eq(stdMaxFeePerGas));

      if (eip1559Chains.includes(chainId)) {
        assert.ok(BigNumber.isBigNumber(gasPrice.maxPriorityFeePerGas));
        assert.ok(gasPrice.maxPriorityFeePerGas.eq(stdMaxPriorityFeePerGas));
      } else {
        // Defaults to Legacy (Type 0)
        assert.ok(gasPrice.maxPriorityFeePerGas.eq(0));
      }
    }
  });

  test("Gas Price Retrieval Failure", async function () {
    jest.setTimeout(25000);
    const feeDataFields = ["gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"];
    const feeDataValues = [null, "test", "1234", 5678, BigNumber.from(-1)];

    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      const chainId = Number(_chainId);

      // Iterate over various faulty values for gasPrice & feeData.
      for (const field of feeDataFields) {
        for (const value of feeDataValues) {
          provider.gasPrice = field === "gasPrice" ? value : stdMaxFeePerGas;
          provider.feeData = {
            gasPrice: field === "gasPrice" ? value : stdMaxFeePerGas,
            maxFeePerGas: field === "maxFeePerGas" ? value : stdMaxFeePerGas,
            maxPriorityFeePerGas: field === "maxPriorityFeePerGas" ? value : stdMaxPriorityFeePerGas,
          };

          // For faulty values that we depend on, ensure that an exception is thrown.
          // Otherwise, validate that the expected values were received.
          if (
            (eip1559Chains.includes(chainId) && ["maxFeePerGas", "maxPriorityFeePerGas"].includes(field)) ||
            (legacyChains.includes(chainId) && ["gasPrice"].includes(field))
          ) {
            await expect(getGasPriceEstimate(provider)).rejects.toThrow();
          } else {
            const gasPrice: GasPriceEstimate = await getGasPriceEstimate(provider);

            dummyLogger.debug({
              at: "Gas Price Oracle#Gas Price Retrieval",
              message: `Retrieved gas price estimate for chain ID ${chainId}.`,
              gasPrice,
            });

            assert.ok(gasPrice);
            // maxPriorityFeePerGas => 0 for Type 0 (legacy) chains.
            const _stdMaxPriorityFeePerGas = eip1559Chains.includes(chainId)
              ? stdMaxPriorityFeePerGas
              : BigNumber.from(0);
            [
              [gasPrice.maxFeePerGas, stdMaxFeePerGas],
              [gasPrice.maxPriorityFeePerGas, _stdMaxPriorityFeePerGas],
            ].forEach(([field, value]) => {
              assert(BigNumber.isBigNumber(field), `Unexpected field: ${field}`);
              assert(field.eq(value), `Field ${field} != ${value}`);
            });
          }
        }
      }
    }
  });

  test("Gas Price Fallback Behaviour", async function () {
    for (const provider of Object.values(providerInstances)) {
      const fakeChainId = 1337;
      provider.gasPrice = stdMaxFeePerGas; // Suppress RPC lookup.

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
