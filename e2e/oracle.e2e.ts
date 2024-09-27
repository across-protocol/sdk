// @note: This test is _not_ run automatically as part of git hooks or CI.
import dotenv from "dotenv";
import winston from "winston";
import { custom } from "viem";
import { providers } from "ethers";
import { getGasPriceEstimate } from "../src/gasPriceOracle";
import { BigNumber, bnZero, parseUnits } from "../src/utils";
import { expect } from "../test/utils";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const stdLastBaseFeePerGas = parseUnits("12", 9);
const stdMaxPriorityFeePerGas = parseUnits("1", 9); // EIP-1559 chains only
const stdMaxFeePerGas = stdLastBaseFeePerGas.add(stdMaxPriorityFeePerGas);
const stdGasPrice = stdMaxFeePerGas;

const customTransport = custom({
  async request({ method, params}: { method: string; params: unknown }) {
    params; // lint
    switch (method) {
      case "eth_gasPrice":
        return BigInt(stdGasPrice.toString());
      case "eth_getBlockByNumber":
        return { baseFeePerGas: BigInt((stdLastBaseFeePerGas.mul(100).div(120)).toString()) };
      case "eth_maxPriorityFeePerGas":
        return BigInt(stdMaxPriorityFeePerGas.toString());
      default:
        console.log(`Unsupported method: ${method}.`);
    }
  }
});

const eip1559Chains = [1, 10, 137, 324, 8453, 42161, 534352];
const chainIds = [ ...eip1559Chains, 1337 ];
let providerInstances: { [chainId: number]: providers.StaticJsonRpcProvider } = {};

describe("Gas Price Oracle", function () {
  before(() => {
    providerInstances = Object.fromEntries(
      chainIds.map((chainId) => {
        const provider = new providers.StaticJsonRpcProvider("https://eth.llamarpc.com");
        return [chainId, provider];
      })
    );
  });

  it("Gas Price Retrieval", async function () {
    for (const [_chainId, provider] of Object.entries(providerInstances)) {
      const chainId = Number(_chainId);

      const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, customTransport);
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Retrieval",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      expect(BigNumber.isBigNumber(maxFeePerGas)).to.be.true;
      expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).to.be.true;

      if (eip1559Chains.includes(chainId)) {
        if (chainId === 137) {
          // The Polygon gas station isn't mocked, so just ensure that the fees have a valid relationship.
          expect(maxFeePerGas.gt(0)).to.be.true;
          expect(maxPriorityFeePerGas.gt(0)).to.be.true;
          expect(maxPriorityFeePerGas.lt(maxFeePerGas)).to.be.true;
        } else if (chainId === 42161) {
          // Arbitrum priority fees are refunded, so drop the priority fee from estimates.
          expect(maxFeePerGas.eq(stdLastBaseFeePerGas.add(1))).to.be.true;
          expect(maxPriorityFeePerGas.eq(1)).to.be.true;
        } else {
          expect(maxFeePerGas.gt(bnZero)).to.be.true;
          expect(maxPriorityFeePerGas.gt(bnZero)).to.be.true;
        }
      } else {
        // Defaults to Legacy (Type 0)
        expect(maxFeePerGas.eq(stdMaxFeePerGas)).to.be.true;
        expect(maxPriorityFeePerGas.eq(bnZero)).to.be.true;
      }
    }
  });
});
