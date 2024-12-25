// @note: This test is more of an e2e test because the Ethers provider tests send real RPC requests
// but I wanted to include it in the unit tests to prevent regressions. We should create mocked
// providers and API's to avoid the API requests.

import dotenv from "dotenv";
import winston from "winston";
import { providers } from "ethers";
import { encodeFunctionData } from 'viem';
import { getGasPriceEstimate } from "../src/gasPriceOracle";
import { BigNumber, bnZero, parseUnits } from "../src/utils";
import { expect, makeCustomTransport, randomAddress } from "../test/utils";
dotenv.config({ path: ".env" });

const dummyLogger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console()],
});

const stdLastBaseFeePerGas = parseUnits("12", 9);
const stdMaxPriorityFeePerGas = parseUnits("1", 9); // EIP-1559 chains only
const expectedLineaMaxFeePerGas = parseUnits("7", 9)
const ethersProviderChainIds = [1, 10, 137, 324, 8453, 42161, 534352, 59144];
const viemProviderChainIds = [59144];

const customTransport = makeCustomTransport({ stdLastBaseFeePerGas, stdMaxPriorityFeePerGas });

const provider = new providers.StaticJsonRpcProvider("https://eth.llamarpc.com");

const ERC20ABI = [
  {
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    name: "transfer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
const erc20TransferTransactionObject = encodeFunctionData({
  abi: ERC20ABI,
  functionName: "transfer",
  args: [randomAddress(), 1n]
})

describe("Gas Price Oracle", function () {
  it("Viem gas price retrieval", async function () {
    for (const chainId of viemProviderChainIds) {
      const chainKey = `NEW_GAS_PRICE_ORACLE_${chainId}`;
      process.env[chainKey] = "true";
      if (chainId === 59144) {
        // For Linea, works with and without passing in a custom Transaction object.
        const unsignedTxns = [
          {
            to: randomAddress(),
            from: randomAddress(),
            value: bnZero,
            data: erc20TransferTransactionObject
          },
          undefined
        ]
        const baseFeeMultiplier = 2.0;
        for (const unsignedTx of unsignedTxns) {
          const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, {
            chainId,
            transport: customTransport,
            unsignedTx,
            baseFeeMultiplier
          });
  
          dummyLogger.debug({
            at: "Viem: Gas Price Oracle",
            message: `Retrieved gas price estimate for chain ID ${chainId}`,
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
            unsignedTx
          });

          expect(BigNumber.isBigNumber(maxFeePerGas)).to.be.true;
          expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).to.be.true;
  
          // For Linea, base fee is expected to be hardcoded and unaffected by the base fee multiplier while
          // the priority fee gets scaled.
          const expectedPriorityFee = stdMaxPriorityFeePerGas.mul(2.0);
          expect(maxFeePerGas).to.equal(expectedLineaMaxFeePerGas.add(expectedPriorityFee));
          expect(maxPriorityFeePerGas).to.equal(expectedPriorityFee)
        }
  
      }
      delete process.env[chainKey];
    }
  });
  it("Ethers gas price retrieval", async function () {
    // TODO: Make this test less flaky by creating a mocked Ethers provider as well
    // as a fake Polygon gas station API, so it doesn't send real RPC requests.

    const baseFeeMultiplier = 2.0;
    // For this test, we only use the raw gas price feed for ethereum just so we can 
    // test both the bad and raw variants, since other chains will ultimately call the Etheruem
    // adapter.
    const eip1559RawGasPriceFeedChainIds = [1];
    for (const chainId of ethersProviderChainIds) {
      if (eip1559RawGasPriceFeedChainIds.includes(chainId)) {
        const chainKey = `GAS_PRICE_EIP1559_RAW_${chainId}`;
        process.env[chainKey] = "true";  
      }
      const [
        { maxFeePerGas: markedUpMaxFeePerGas, maxPriorityFeePerGas: markedUpMaxPriorityFeePerGas },
        { maxFeePerGas, maxPriorityFeePerGas }
       ] =
        await Promise.all([
          getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, transport: customTransport }),
          getGasPriceEstimate(provider, { chainId, baseFeeMultiplier: 1.0, transport: customTransport }),
        ]
      );

      dummyLogger.debug({
        at: "Ethers: Gas Price Oracle",
        message: `Retrieved gas price estimate for chain ID ${chainId}`,
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        markedUpMaxFeePerGas: markedUpMaxFeePerGas.toString(),
        markedUpMaxPriorityFeePerGas: markedUpMaxPriorityFeePerGas.toString()
      });

      expect(BigNumber.isBigNumber(maxFeePerGas)).to.be.true;
      expect(BigNumber.isBigNumber(maxPriorityFeePerGas)).to.be.true;
      
      // @dev: The following tests *might* be flaky because the above two getGasPriceEstimate
      // calls are technically two separate API calls and the suggested base and priority fees
      // might be different. In practice, the fees rarely change when called in rapid succession.

      // Base fee should be multiplied by multiplier. Returned max fee includes priority fee 
      // so back it ou.
      const expectedMarkedUpMaxFeePerGas = (maxFeePerGas.sub(maxPriorityFeePerGas)).mul(2)
      expect(markedUpMaxFeePerGas.sub(markedUpMaxPriorityFeePerGas)).to.equal(expectedMarkedUpMaxFeePerGas);
      expect(markedUpMaxFeePerGas.gt(maxFeePerGas)).to.be.true;
      
      // Priority fees should be the same
      expect(markedUpMaxPriorityFeePerGas).to.equal(maxPriorityFeePerGas)
      
      if (chainId === 42161) {
        // Arbitrum priority fee should be 1 wei.
        expect(markedUpMaxPriorityFeePerGas).to.equal(1);
        expect(maxPriorityFeePerGas).to.equal(1);
      } 
      if (eip1559RawGasPriceFeedChainIds.includes(chainId)) {
        const chainKey = `GAS_PRICE_EIP1559_RAW_${chainId}`;
        delete process.env[chainKey];
      }
    }
  });
});
