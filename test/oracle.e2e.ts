// @note: This test is _not_ run automatically as part of git hooks or CI.
import dotenv from "dotenv";
import winston from "winston";
import { BigNumber, providers, utils as ethersUtils } from "ethers";
import { getGasPriceEstimate } from "../src/gasPriceOracle";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

type FeeData = providers.FeeData;

class MockedProvider extends providers.StaticJsonRpcProvider {
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
  1: "https://eth.llamarpc.com",
  10: "https://mainnet.optimism.io",
  137: "https://polygon.llamarpc.com",
  288: "https://mainnet.boba.network",
  324: "https://mainnet.era.zksync.io",
  8453: "https://mainnet.base.org",
  42161: "https://rpc.ankr.com/arbitrum",
};

const stdGasPrice = ethersUtils.parseUnits("10", 9);
const stdMaxPriorityFeePerGas = ethersUtils.parseUnits("1.5", 9); // EIP-1559 chains only
const stdLastBaseFeePerGas = stdGasPrice.sub(stdMaxPriorityFeePerGas);
const stdMaxFeePerGas = stdGasPrice;
const eip1559Chains = [1, 10, 137, 8453, 42161];
const legacyChains = [288, 324];

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
        lastBaseFeePerGas: stdLastBaseFeePerGas,
        maxPriorityFeePerGas: stdMaxPriorityFeePerGas,
      };
      provider.testGasPrice = stdGasPrice; // Required: same as provider.feeData.gasPrice.
    }
  });

  test("Gas Price Retrieval", async function () {
    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      const chainId = Number(_chainId);

      const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider);
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Retrieval",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      expect(BigNumber.isBigNumber(maxFeePerGas)).toBe(true);
      expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).toBe(true);

      if (eip1559Chains.includes(chainId)) {
        if (chainId === 137) {
          // The Polygon gas station isn't mocked, so just ensure that the fees have a valid relationship.
          expect(maxFeePerGas.gt(0)).toBe(true);
          expect(maxPriorityFeePerGas.gt(0)).toBe(true);
          expect(maxPriorityFeePerGas.lt(maxFeePerGas)).toBe(true);
        } else if (chainId === 42161) {
          // Arbitrum priority fees are refunded, so drop the priority fee from estimates.
          expect(maxFeePerGas.eq(stdLastBaseFeePerGas.add(1))).toBe(true);
          expect(maxPriorityFeePerGas.eq(1)).toBe(true);
        } else {
          expect(maxFeePerGas.eq(stdMaxFeePerGas)).toBe(true);
          expect(maxPriorityFeePerGas.eq(stdMaxPriorityFeePerGas)).toBe(true);
        }
      } else {
        // Defaults to Legacy (Type 0)
        expect(maxFeePerGas.eq(stdGasPrice)).toBe(true);
        expect(maxPriorityFeePerGas.eq(0)).toBe(true);
      }
    }
  }, 10000);

  test("Gas Price Retrieval Failure", async function () {
    const feeDataFields = ["gasPrice", "lastBaseFeePerGas", "maxPriorityFeePerGas"];
    const feeDataValues = [null, "test", "1234", 5678, BigNumber.from(-1)];

    // Iterate over various faulty values for gasPrice & feeData.
    // Loop one chain at a time to minimise rate-limiting in case a public RPC is being used.
    for (const field of feeDataFields) {
      for (const value of feeDataValues) {
        for (const [_chainId, provider] of Object.entries(providerInstances)) {
          const chainId = Number(_chainId);

          provider.testGasPrice = field === "gasPrice" ? value : stdGasPrice;
          provider.testFeeData = {
            gasPrice: field === "gasPrice" ? value : stdGasPrice,
            lastBaseFeePerGas: field === "lastBaseFeePerGas" ? value : stdLastBaseFeePerGas,
            maxPriorityFeePerGas: field === "maxPriorityFeePerGas" ? value : stdMaxPriorityFeePerGas,
          };

          // Malformed inputs were supplied; ensure an exception is thrown.
          if (
            (legacyChains.includes(chainId) && ["gasPrice"].includes(field)) ||
            (chainId !== 137 &&
              eip1559Chains.includes(chainId) &&
              ["lastBaseFeePerGas", "maxPriorityFeePerGas"].includes(field))
          ) {
            provider.testGasPrice = field === "gasPrice" ? value : stdGasPrice;
            await expect(getGasPriceEstimate(provider, chainId)).rejects.toThrow();
          } else {
            // Expect sane results to be returned; validate them.
            const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, chainId);

            dummyLogger.debug({
              at: "Gas Price Oracle#Gas Price Retrieval Failure",
              message: `Retrieved gas price estimate for chain ID ${chainId}.`,
              maxFeePerGas,
              maxPriorityFeePerGas,
            });

            expect(BigNumber.isBigNumber(maxFeePerGas)).toBe(true);
            expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).toBe(true);

            if (eip1559Chains.includes(chainId)) {
              if (chainId === 137) {
                expect(maxFeePerGas.gt(0)).toBe(true);
                expect(maxPriorityFeePerGas.gt(0)).toBe(true);
                expect(maxPriorityFeePerGas.lt(maxFeePerGas)).toBe(true);
              } else if (chainId === 42161) {
                expect(maxFeePerGas.eq(stdLastBaseFeePerGas.add(1))).toBe(true);
                expect(maxPriorityFeePerGas.eq(1)).toBe(true);
              } else {
                expect(maxFeePerGas.eq(stdMaxFeePerGas)).toBe(true);
                expect(maxPriorityFeePerGas.eq(stdMaxPriorityFeePerGas)).toBe(true);
              }
            } else {
              // Legacy
              expect(maxFeePerGas.eq(stdGasPrice)).toBe(true);
              expect(maxPriorityFeePerGas.eq(0)).toBe(true);
            }
          }
        }
      }
    }
  }, 25000);

  test("Gas Price Fallback Behaviour", async function () {
    for (const provider of Object.values(providerInstances)) {
      const fakeChainId = 1337;

      const chainId = (await provider.getNetwork()).chainId;
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Fallback Behaviour",
        message: `Testing on chainId ${chainId}.`,
      });

      provider.testGasPrice = stdMaxFeePerGas; // Suppress RPC lookup.

      const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, fakeChainId, true);

      // Require legacy pricing when fallback is permitted.
      expect(BigNumber.isBigNumber(maxFeePerGas)).toBe(true);
      expect(maxFeePerGas.eq(stdMaxFeePerGas)).toBe(true);

      expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).toBe(true);
      expect(maxPriorityFeePerGas.eq(0)).toBe(true);

      // Verify an assertion is thrown when fallback is not permitted.
      await expect(getGasPriceEstimate(provider, fakeChainId, false)).rejects.toThrow();
    }
  });
});
