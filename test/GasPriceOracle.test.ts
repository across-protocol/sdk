// @note: This test is more of an e2e test because the Ethers provider tests send real RPC requests
// but I wanted to include it in the unit tests to prevent regressions. We should create mocked
// providers and API's to avoid the API requests.

import dotenv from "dotenv";
import { encodeFunctionData } from "viem";
import { getGasPriceEstimate } from "../src/gasPriceOracle";
import { BigNumber, bnZero, fixedPointAdjustment, parseUnits, toBNWei } from "../src/utils";
import { assertPromiseError, expect, makeCustomTransport, randomAddress } from "../test/utils";
import { MockedProvider } from "./utils/provider";
import { MockPolygonGasStationBaseFee, MockPolygonGasStationPriorityFee } from "../src/gasPriceOracle/adapters/polygon";
dotenv.config({ path: ".env" });

const stdLastBaseFeePerGas = parseUnits("12", 9);
const stdMaxPriorityFeePerGas = parseUnits("1", 9); // EIP-1559 chains only
const expectedLineaMaxFeePerGas = BigNumber.from("7");
const legacyChainIds = [324, 59144, 534352];
const arbOrbitChainIds = [42161, 41455];
const ethersProviderChainIds = [10, 8453, ...legacyChainIds, ...arbOrbitChainIds];

const customTransport = makeCustomTransport({ stdLastBaseFeePerGas, stdMaxPriorityFeePerGas });

const provider = new MockedProvider(stdLastBaseFeePerGas, stdMaxPriorityFeePerGas);

const ERC20ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
const erc20TransferTransactionObject = encodeFunctionData({
  abi: ERC20ABI,
  functionName: "transfer",
  args: [randomAddress(), 1n],
});

describe("Gas Price Oracle", function () {
  it("baseFeeMultiplier is validated", async function () {
    // Too low:
    await assertPromiseError(
      getGasPriceEstimate(provider, {
        chainId: 1,
        baseFeeMultiplier: toBNWei("0.5"),
      }),
      "base fee multiplier"
    );
    // Too high:
    await assertPromiseError(
      getGasPriceEstimate(provider, {
        chainId: 1,
        baseFeeMultiplier: toBNWei("5.5"),
      }),
      "base fee multiplier"
    );
  });
  it("priorityFeeMultiplier is validated", async function () {
    // Too low:
    await assertPromiseError(
      getGasPriceEstimate(provider, {
        chainId: 1,
        priorityFeeMultiplier: toBNWei("0.5"),
      }),
      "priority fee multiplier"
    );
    // Too high:
    await assertPromiseError(
      getGasPriceEstimate(provider, {
        chainId: 1,
        priorityFeeMultiplier: toBNWei("5.5"),
      }),
      "priority fee multiplier"
    );
  });
  it("Linea Viem gas price retrieval with unsignedTx", async function () {
    const chainId = 59144;
    const chainKey = `NEW_GAS_PRICE_ORACLE_${chainId}`;
    process.env[chainKey] = "true";
    const unsignedTx = {
      to: randomAddress(),
      from: randomAddress(),
      value: bnZero,
      data: erc20TransferTransactionObject,
    };
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, {
      chainId,
      transport: customTransport,
      unsignedTx,
      baseFeeMultiplier: toBNWei("2.0"),
      priorityFeeMultiplier: toBNWei("2.0"), // Priority fee multiplier should be unused in Linea.
    });

    // For Linea, base fee is expected to be hardcoded and unaffected by the base fee multiplier while
    // the priority fee gets scaled.
    // Additionally, test that the unsignedTx with a non-empty data field gets passed into the
    // Linea viem provider. We've mocked the customTransport to double the priority fee if
    // the unsigned tx object has non-empty data
    const expectedPriorityFee = stdMaxPriorityFeePerGas.mul(4.0);
    expect(maxFeePerGas).to.equal(expectedLineaMaxFeePerGas.add(expectedPriorityFee));
    expect(maxPriorityFeePerGas).to.equal(expectedPriorityFee);
    delete process.env[chainKey];
  });
  it("Linea Viem gas price retrieval", async function () {
    const chainId = 59144;
    const chainKey = `NEW_GAS_PRICE_ORACLE_${chainId}`;
    process.env[chainKey] = "true";
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, {
      chainId,
      transport: customTransport,
      baseFeeMultiplier: toBNWei("2.0"),
      priorityFeeMultiplier: toBNWei("2.0"), // Priority fee multiplier should be unused in Linea.
    });

    // For Linea, base fee is expected to be hardcoded and unaffected by the base fee multiplier while
    // the priority fee gets scaled.
    const expectedPriorityFee = stdMaxPriorityFeePerGas.mul(2.0);
    expect(maxFeePerGas).to.equal(expectedLineaMaxFeePerGas.add(expectedPriorityFee));
    expect(maxPriorityFeePerGas).to.equal(expectedPriorityFee);
    delete process.env[chainKey];
  });
  it("Ethers gas price retrieval", async function () {
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    for (const chainId of ethersProviderChainIds) {
      const { maxFeePerGas: markedUpMaxFeePerGas, maxPriorityFeePerGas: markedUpMaxPriorityFeePerGas } =
        await getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, priorityFeeMultiplier });

      // Base fee for EIP1559 gas price feeds should be multiplied by multiplier.
      // Returned max fee includes priority fee so back it out.
      const expectedMarkedUpMaxFeePerGas = stdLastBaseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment);
      const expectedMarkedUpPriorityFee = stdMaxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);

      if (arbOrbitChainIds.includes(chainId)) {
        expect(markedUpMaxFeePerGas.sub(markedUpMaxPriorityFeePerGas)).to.equal(expectedMarkedUpMaxFeePerGas);
        // Arbitrum orbit priority fee should be 1 wei.
        expect(markedUpMaxPriorityFeePerGas).to.equal(1);
      } else if (legacyChainIds.includes(chainId)) {
        // Scroll and ZkSync use legacy pricing so priority fee should be 0.
        expect(markedUpMaxPriorityFeePerGas).to.equal(0);
        // Legacy gas price = base fee + priority fee and full value is scaled by the base fee multiplier.
        expect(markedUpMaxFeePerGas).to.equal(
          stdLastBaseFeePerGas.add(stdMaxPriorityFeePerGas).mul(baseFeeMultiplier).div(fixedPointAdjustment)
        );
      } else {
        expect(markedUpMaxFeePerGas.sub(markedUpMaxPriorityFeePerGas)).to.equal(expectedMarkedUpMaxFeePerGas);
        // Priority fees should be scaled by priority fee multiplier.
        expect(markedUpMaxPriorityFeePerGas).to.equal(expectedMarkedUpPriorityFee);
      }
    }
  });
  it("Ethers EIP1559 Raw", async function () {
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    const chainId = 1;
    const chainKey = `GAS_PRICE_EIP1559_RAW_${chainId}`;
    process.env[chainKey] = "true";

    const { maxFeePerGas: markedUpMaxFeePerGas, maxPriorityFeePerGas: markedUpMaxPriorityFeePerGas } =
      await getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, priorityFeeMultiplier });

    // Base fee should be multiplied by multiplier. Returned max fee includes priority fee
    // so back it out before scaling.
    const expectedMarkedUpPriorityFee = stdMaxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
    const expectedMarkedUpMaxFeePerGas = stdLastBaseFeePerGas
      .mul(baseFeeMultiplier)
      .div(fixedPointAdjustment)
      .add(expectedMarkedUpPriorityFee);
    expect(markedUpMaxFeePerGas).to.equal(expectedMarkedUpMaxFeePerGas);

    // Priority fees should be scaled.
    expect(markedUpMaxPriorityFeePerGas).to.equal(expectedMarkedUpPriorityFee);
    delete process.env[chainKey];
  });
  it("Ethers EIP1559 Bad", async function () {
    // This test should return identical results to the Raw test but it makes different
    // provider calls, so we're really testing that the expected provider functions are called.
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    const chainId = 1;

    const { maxFeePerGas: markedUpMaxFeePerGas, maxPriorityFeePerGas: markedUpMaxPriorityFeePerGas } =
      await getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, priorityFeeMultiplier });

    // Base fee should be multiplied by multiplier. Returned max fee includes priority fee
    // so back it out before scaling.
    const expectedMarkedUpPriorityFee = stdMaxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
    const expectedMarkedUpMaxFeePerGas = stdLastBaseFeePerGas
      .mul(baseFeeMultiplier)
      .div(fixedPointAdjustment)
      .add(expectedMarkedUpPriorityFee);
    expect(markedUpMaxFeePerGas).to.equal(expectedMarkedUpMaxFeePerGas);

    // Priority fees should be scaled.
    expect(markedUpMaxPriorityFeePerGas).to.equal(expectedMarkedUpPriorityFee);
  });
  it("Ethers Legacy", async function () {
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    const chainId = 324;

    const { maxFeePerGas: markedUpMaxFeePerGas, maxPriorityFeePerGas: markedUpMaxPriorityFeePerGas } =
      await getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, priorityFeeMultiplier });

    // Legacy gas price is equal to base fee + priority fee and the full amount
    // should be multiplied by the base fee multiplier since the RPC won't return the broken down fee.
    // The priority fee multiplier should be unused.
    const expectedGasPrice = stdLastBaseFeePerGas.add(stdMaxPriorityFeePerGas);
    const expectedMarkedUpMaxFeePerGas = expectedGasPrice.mul(baseFeeMultiplier).div(fixedPointAdjustment);
    expect(expectedMarkedUpMaxFeePerGas).to.equal(markedUpMaxFeePerGas);

    // Priority fees should be zero
    expect(markedUpMaxPriorityFeePerGas).to.equal(0);
  });
  it("Ethers Polygon GasStation", async function () {
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    process.env["TEST_POLYGON_GAS_STATION"] = "true";
    const chainId = 137;
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, {
      chainId,
      baseFeeMultiplier,
      priorityFeeMultiplier,
    });

    const expectedPriorityFee = MockPolygonGasStationPriorityFee().mul(priorityFeeMultiplier).div(fixedPointAdjustment);
    expect(maxFeePerGas).to.equal(
      MockPolygonGasStationBaseFee().mul(baseFeeMultiplier).div(fixedPointAdjustment).add(expectedPriorityFee)
    );
    expect(maxPriorityFeePerGas).to.equal(expectedPriorityFee);
    delete process.env["TEST_POLYGON_GAS_STATION"];
  });
  it("Ethers Polygon GasStation: Fallback", async function () {
    const baseFeeMultiplier = toBNWei("2.0");
    const priorityFeeMultiplier = toBNWei("1.5");
    process.env["TEST_REVERTING_POLYGON_GAS_STATION"] = "true";
    const chainId = 137;

    // If GasStation getFeeData throws, then the Polygon gas price oracle adapter should fallback to the
    // ethereum EIP1559 logic. There should be logic to ensure the priority fee gets floored at 30 gwei.
    const { maxFeePerGas, maxPriorityFeePerGas } = await getGasPriceEstimate(provider, {
      chainId,
      baseFeeMultiplier,
      priorityFeeMultiplier,
    });

    const minPolygonPriorityFee = parseUnits("30", 9).mul(priorityFeeMultiplier).div(fixedPointAdjustment);
    const markedUpPriorityFee = stdMaxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
    const expectedPriorityFee = markedUpPriorityFee.gt(minPolygonPriorityFee)
      ? markedUpPriorityFee
      : minPolygonPriorityFee;
    expect(maxFeePerGas).to.equal(
      stdLastBaseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment).add(expectedPriorityFee)
    );
    expect(maxPriorityFeePerGas).to.equal(expectedPriorityFee);
    delete process.env["TEST_REVERTING_POLYGON_GAS_STATION"];
  });
});
