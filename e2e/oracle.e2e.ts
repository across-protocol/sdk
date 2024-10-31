// @note: This test is _not_ run automatically as part of git hooks or CI.
import dotenv from "dotenv";
import winston from "winston";
import { getGasPriceEstimate } from "../src/gasPriceOracle";
import { BigNumber, bnZero, parseUnits } from "../src/utils";
import { expect, makeCustomTransport } from "../test/utils";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const stdLastBaseFeePerGas = parseUnits("12", 9);
const stdMaxPriorityFeePerGas = parseUnits("1", 9); // EIP-1559 chains only
const chainIds = [1, 10, 137, 324, 8453, 42161, 534352];

const customTransport = makeCustomTransport({ stdLastBaseFeePerGas, stdMaxPriorityFeePerGas });

describe("Gas Price Oracle", function () {
  it("Gas Price Retrieval", async function () {
    for (const chainId of chainIds) {
      const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(chainId, customTransport);
      dummyLogger.debug({
        at: "Gas Price Oracle#Gas Price Retrieval",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      expect(BigNumber.isBigNumber(maxFeePerGas)).to.be.true;
      expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).to.be.true;

      if (chainIds.includes(chainId)) {
        if (chainId === 137) {
          // The Polygon gas station isn't mocked, so just ensure that the fees have a valid relationship.
          expect(maxFeePerGas.gt(0)).to.be.true;
          expect(maxPriorityFeePerGas.gt(0)).to.be.true;
          expect(maxPriorityFeePerGas.lt(maxFeePerGas)).to.be.true;
        } else if (chainId === 42161) {
          // Arbitrum priority fees are refunded, so drop the priority fee from estimates.
          // Expect a 1.2x multiplier on the last base fee.
          expect(maxFeePerGas.eq(stdLastBaseFeePerGas.mul("120").div("100").add(1))).to.be.true;
          expect(maxPriorityFeePerGas.eq(1)).to.be.true;
        } else {
          expect(maxFeePerGas.gt(bnZero)).to.be.true;
          expect(maxPriorityFeePerGas.gt(bnZero)).to.be.true;
        }
      }
    }
  });
});
