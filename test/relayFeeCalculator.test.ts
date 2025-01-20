import dotenv from "dotenv";
import hre from "hardhat";
import { RelayFeeCalculator, QueryInterface } from "../src/relayFeeCalculator/relayFeeCalculator";
import {
  toBNWei,
  toBN,
  toGWei,
  TransactionCostEstimate,
  bnOne,
  getCurrentTime,
  spreadEvent,
  isMessageEmpty,
  fixedPointAdjustment,
  toBytes32,
} from "../src/utils";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  assert,
  assertPromiseError,
  assertPromisePasses,
  buildDepositForRelayerFeeTest,
  deploySpokePoolWithToken,
  ethers,
  expect,
  getContractFactory,
  randomAddress,
  setupTokensForWallet,
  makeCustomTransport,
} from "./utils";
import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import { SpokePool } from "@across-protocol/contracts";
import { QueryBase, QueryBase__factory } from "../src/relayFeeCalculator";
import { getDefaultProvider } from "ethers";
import { MockedProvider } from "./utils/provider";

dotenv.config({ path: ".env" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const testCapitalCostsConfig: {
  [token: string]: { lowerBound: string; upperBound: string; cutoff: string; decimals: number };
} = {
  WBTC: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.002").toString(),
    cutoff: toBNWei("15").toString(),
    decimals: 8,
  },
  DAI: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.0015").toString(),
    cutoff: toBNWei("500000").toString(),
    decimals: 18,
  },
  ZERO_CUTOFF_DAI: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.0015").toString(),
    cutoff: "0",
    decimals: 18,
  },
  ZERO_CUTOFF_WBTC: {
    lowerBound: toBNWei("0.0003").toString(),
    upperBound: toBNWei("0.002").toString(),
    cutoff: "0",
    decimals: 8,
  },
  USDC: {
    lowerBound: toBNWei("0").toString(),
    upperBound: toBNWei("0").toString(),
    cutoff: toBNWei("0").toString(),
    decimals: 6,
  },
};

// Example of how to write this query class
class ExampleQueries implements QueryInterface {
  constructor(private defaultGas = "305572") {}

  getGasCosts(): Promise<TransactionCostEstimate> {
    const getGasCost = () => {
      const { defaultGas: gasCost } = this;
      const gasPrice = toGWei("1");
      return {
        nativeGasCost: toBN(gasCost),
        tokenGasCost: toBN(gasCost).mul(gasPrice),
        gasPrice,
      };
    };

    return Promise.resolve(getGasCost());
  }

  getTokenPrice(): Promise<number> {
    // Return token price denominated in ETH, assuming ETH is native token.
    return Promise.resolve(1 / 1000); // 1 USDC = 1 / $1000 ETH/USD
  }
  getTokenDecimals(): number {
    return 6;
  }
}
describe("RelayFeeCalculator", () => {
  let client: RelayFeeCalculator;
  let queries: ExampleQueries;
  beforeEach(() => {
    queries = new ExampleQueries();
  });
  it("gasPercentageFee", async () => {
    client = new RelayFeeCalculator({ queries, capitalCostsConfig: testCapitalCostsConfig });
    // A list of inputs and ground truth [input, ground truth]
    const gasFeePercents = [
      [0, Number.MAX_SAFE_INTEGER.toString()], // Infinite%
      [1000, toBNWei("305.572").toString()], // ~30,500%
      [5000, toBNWei("61.1144").toString()], // ~61,00%
      [305571, toBNWei("1.000003272561859600").toString()], // 100%
      [1_000_000e6, toBNWei("0.000000305572").toString()], // ~0%
      // A test with a prime number
      [104729, toBNWei("2.917740071995340354").toString()], // ~291%
    ];
    for (const [input, truth] of gasFeePercents) {
      const result = (
        await client.gasFeePercent(buildDepositForRelayerFeeTest(input, "usdc", 1, 10), input, false)
      ).toString();
      expect(result).to.be.eq(truth);
    }
  });
  it("relayerFeeDetails", async () => {
    client = new RelayFeeCalculator({ queries, capitalCostsConfig: testCapitalCostsConfig });
    const result = await client.relayerFeeDetails(buildDepositForRelayerFeeTest(100e6, "usdc", "10", "1"), 100e6);
    assert.ok(result);
    // overriding token price also succeeds
    const resultWithPrice = await client.relayerFeeDetails(
      buildDepositForRelayerFeeTest(100e6, "usdc", "10", "1"),
      100e6,
      false,
      randomAddress(),
      1.01
    );
    assert.ok(resultWithPrice);

    // gasFeePercent is lower if token price is higher.
    assert.equal(
      true,
      toBN(resultWithPrice.gasFeePercent).lt(
        (
          await client.relayerFeeDetails(
            buildDepositForRelayerFeeTest(100e6, "usdc", "1", "10"),
            100e6,
            false,
            undefined,
            1.0
          )
        ).gasFeePercent
      )
    );

    // With fee limit defaulted to 0%, the maxGasFeePercent should be 0 and the minDeposit should be infinite.
    assert.equal(resultWithPrice.maxGasFeePercent, "0");
    assert.equal(resultWithPrice.minDeposit, Number.MAX_SAFE_INTEGER.toString());

    // Set fee limit percent to 10%:
    client = new RelayFeeCalculator({ queries, feeLimitPercent: 10, capitalCostsConfig: testCapitalCostsConfig });
    // Compute relay fee details for an $1000 transfer. Capital fee % is 0 so maxGasFeePercent should be equal to fee
    // limit percent.
    const relayerFeeDetails = await client.relayerFeeDetails(
      buildDepositForRelayerFeeTest(1000e6, "usdc", "10", "1"),
      1000e6
    );
    assert.equal(relayerFeeDetails.maxGasFeePercent, toBNWei("0.1").toString());
    assert.equal(relayerFeeDetails.gasFeeTotal, "305572"); // 305,572 gas units
    assert.equal(relayerFeeDetails.minDeposit, toBNWei("3.05572", 6).toString()); // 305,572 / 0.1 = 3055720 then divide by 1e6
    assert.equal(relayerFeeDetails.isAmountTooLow, false);
    assert.equal(
      (await client.relayerFeeDetails(buildDepositForRelayerFeeTest(10e6, "usdc", "10", "1"), 10e6)).isAmountTooLow,
      false
    );
    assert.equal(
      (await client.relayerFeeDetails(buildDepositForRelayerFeeTest(1e6, "usdc", "10", "1"), 1e6)).isAmountTooLow,
      true
    );
  });
  it("capitalFeePercent", () => {
    // Invalid capital cost configs throws on construction:
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: {
            WBTC: { ...testCapitalCostsConfig["WBTC"], upperBound: toBNWei("0.01").toString() },
          },
        }),
      /upper bound must be </
    );
    assert.throws(
      () =>
        RelayFeeCalculator.validateCapitalCostsConfig({
          ...testCapitalCostsConfig["WBTC"],
          upperBound: toBNWei("0.01").toString(),
        }),
      /upper bound must be </
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: { WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 0 } },
        }),
      /invalid decimals/
    );
    assert.throws(
      () => RelayFeeCalculator.validateCapitalCostsConfig({ ...testCapitalCostsConfig["WBTC"], decimals: 0 }),
      /invalid decimals/
    );
    assert.throws(
      () =>
        new RelayFeeCalculator({
          queries,
          capitalCostsConfig: { WBTC: { ...testCapitalCostsConfig["WBTC"], decimals: 19 } },
        }),
      /invalid decimals/
    );
    assert.throws(
      () => RelayFeeCalculator.validateCapitalCostsConfig({ ...testCapitalCostsConfig["WBTC"], decimals: 19 }),
      /invalid decimals/
    );
    const client = new RelayFeeCalculator({
      queries,
      capitalCostsConfig: testCapitalCostsConfig,
    });

    // If token doesn't have a config set, then throws an error.
    assert.throws(
      () => client.capitalFeePercent(toBNWei("1"), "UNKNOWN"),
      /No capital cost config available for token/
    );

    // Test with different decimals:

    // Amount near zero should charge slightly more than lower bound
    assert.equal(
      client.capitalFeePercent(toBNWei("0.001", 8), "WBTC").toString(),
      toBNWei("0.000300056666666").toString()
    );
    assert.equal(client.capitalFeePercent(toBNWei("1"), "DAI").toString(), toBNWei("0.0003000012").toString());
    // Amount right below cutoff should charge slightly below 1/2 of (lower bound + upper bound)
    assert.equal(
      client.capitalFeePercent(toBNWei("14.999", 8), "WBTC").toString(),
      toBNWei("0.00114994333333333").toString()
    );
    assert.equal(client.capitalFeePercent(toBNWei("499999"), "DAI").toString(), toBNWei("0.0008999988").toString());
    // Amount >>> than cutoff should charge slightly below upper bound
    assert.equal(
      client.capitalFeePercent(toBNWei("600", 8), "WBTC").toString(),
      toBNWei("0.001978749999999999").toString()
    );
    assert.equal(client.capitalFeePercent(toBNWei("20000000"), "DAI").toString(), toBNWei("0.001485").toString());
    // Handles zero cutoff where triangle charge is 0. Should charge upper bound on any amount.
    assert.equal(client.capitalFeePercent(toBNWei("1"), "ZERO_CUTOFF_DAI").toString(), toBNWei("0.0015").toString());
    assert.equal(
      client.capitalFeePercent(toBNWei("499999"), "ZERO_CUTOFF_DAI").toString(),
      toBNWei("0.0015").toString()
    );
    assert.equal(
      client.capitalFeePercent(toBNWei("20000000"), "ZERO_CUTOFF_DAI").toString(),
      toBNWei("0.0015").toString()
    );
    assert.equal(
      client.capitalFeePercent(toBNWei("0.001", 8), "ZERO_CUTOFF_WBTC").toString(),
      toBNWei("0.002").toString()
    );
    assert.equal(
      client.capitalFeePercent(toBNWei("14.999", 8), "ZERO_CUTOFF_WBTC").toString(),
      toBNWei("0.002").toString()
    );
    assert.equal(
      client.capitalFeePercent(toBNWei("600", 8), "ZERO_CUTOFF_WBTC").toString(),
      toBNWei("0.002").toString()
    );
    // Handles zero amount and charges Infinity% in all cases.
    assert.equal(client.capitalFeePercent("0", "ZERO_CUTOFF_DAI").toString(), Number.MAX_SAFE_INTEGER.toString());
    assert.equal(client.capitalFeePercent("0", "DAI").toString(), Number.MAX_SAFE_INTEGER.toString());
    assert.equal(client.capitalFeePercent("0", "ZERO_CUTOFF_WBTC").toString(), Number.MAX_SAFE_INTEGER.toString());
    assert.equal(client.capitalFeePercent("0", "WBTC").toString(), Number.MAX_SAFE_INTEGER.toString());
  });
});

describe("RelayFeeCalculator: Composable Bridging", function () {
  let spokePool: SpokePool, erc20: Contract, destErc20: Contract, weth: Contract;
  let client: RelayFeeCalculator;
  let queries: QueryBase;
  let testContract: Contract;
  let owner: SignerWithAddress, relayer: SignerWithAddress, depositor: SignerWithAddress;
  let tokenMap: typeof TOKEN_SYMBOLS_MAP;
  let testGasFeePct: (message?: string) => Promise<BigNumber>;
  const customTransport = makeCustomTransport();

  beforeEach(async function () {
    [owner, relayer, depositor] = await ethers.getSigners();

    const {
      spokePool: _spokePool,
      erc20: _erc20,
      weth: _weth,
      destErc20: _destErc20,
    } = await deploySpokePoolWithToken(1, 10);

    spokePool = _spokePool as SpokePool;
    erc20 = _erc20;
    weth = _weth;
    destErc20 = _destErc20;

    tokenMap = {
      USDC: {
        name: "USDC",
        symbol: "USDC",
        decimals: 6,
        addresses: {
          1: erc20.address,
          10: erc20.address,
        },
      },
    } as unknown as typeof TOKEN_SYMBOLS_MAP;
    await (spokePool as Contract).setChainId(10); // The spoke pool for a fill should be at the destinationChainId.
    await setupTokensForWallet(spokePool, relayer, [erc20, destErc20], weth, 100);
    spokePool = spokePool.connect(relayer);

    testContract = await hre["upgrades"].deployProxy(await getContractFactory("MockAcrossMessageContract", owner), []);
    queries = QueryBase__factory.create(1, spokePool.provider, tokenMap, spokePool.address, relayer.address);
    client = new RelayFeeCalculator({ queries, capitalCostsConfig: testCapitalCostsConfig });

    testGasFeePct = (message?: string) =>
      client.gasFeePercent(
        {
          inputAmount: bnOne,
          outputAmount: bnOne,
          inputToken: erc20.address,
          outputToken: destErc20.address,
          recipient: testContract.address,
          quoteTimestamp: 1,
          depositId: 1000000,
          depositor: depositor.address,
          originChainId: 10,
          destinationChainId: 1,
          message: message || EMPTY_MESSAGE,
          exclusiveRelayer: ZERO_ADDRESS,
          fillDeadline: getCurrentTime() + 60000,
          exclusivityDeadline: 0,
          fromLiteChain: false,
          toLiteChain: false,
        },
        1,
        false,
        relayer.address,
        1,
        tokenMap,
        undefined,
        undefined,
        undefined,
        customTransport
      );
  });
  it("should not revert if no message is passed", async () => {
    await assertPromisePasses(testGasFeePct());
  });
  it("should revert if the contract message fails", async () => {
    // Per our test contract, this message will revert.
    const message = ethers.utils.hexlify(ethers.utils.toUtf8Bytes("REVERT"));
    await assertPromiseError(testGasFeePct(message), "MockAcrossMessageContract: revert");
  });
  it("should be more gas to call a contract with a message", async () => {
    const gasFeeFromTestContract = await testContract.estimateGas.handleV3AcrossMessage(
      erc20.address,
      bnOne,
      relayer.address,
      "0x04"
    );
    const gasFeeFromFillRelayWithoutMessage = await spokePool.estimateGas.fillV3Relay(
      {
        depositor: depositor.address,
        inputToken: erc20.address,
        outputToken: erc20.address,
        inputAmount: 1,
        outputAmount: 1,
        recipient: testContract.address,
        depositId: 3_000_000,
        originChainId: 1,
        message: EMPTY_MESSAGE,
        exclusiveRelayer: ZERO_ADDRESS,
        fillDeadline: getCurrentTime() + 60,
        exclusivityDeadline: 0,
      },
      10
    );
    const gasFeeFromFillRelayWithMessage = await spokePool.estimateGas.fillV3Relay(
      {
        depositor: depositor.address,
        inputToken: erc20.address,
        outputToken: erc20.address,
        inputAmount: 1,
        outputAmount: 1,
        recipient: testContract.address,
        depositId: 1000000,
        originChainId: 1,
        message: "0x04",
        exclusiveRelayer: ZERO_ADDRESS,
        fillDeadline: getCurrentTime() + 60,
        exclusivityDeadline: 0,
      },
      10
    );
    const intrinsicGasCost = toBN(21_000);

    // We expect the gas fee to be higher when calling a contract with a message
    // Specifically, we expect that our gas should be larger than a call to the test contract
    // and a call to the fillRelay function without a message.
    // We should account for the second intrinsic gas cost when adding the gas estimation from *both* calls.
    const gasFeeEstimatedByCallingContract = gasFeeFromFillRelayWithoutMessage
      .add(gasFeeFromTestContract)
      .sub(intrinsicGasCost);

    expect(gasFeeFromFillRelayWithMessage.gt(gasFeeEstimatedByCallingContract)).to.be.true;
  });

  it("should pull all relayExecutionInfo when a message exists", async () => {
    // Fill a relay with a message
    await spokePool.fillV3Relay(
      {
        depositor: depositor.address,
        inputToken: erc20.address,
        outputToken: erc20.address,
        inputAmount: 1,
        outputAmount: 1,
        recipient: testContract.address,
        depositId: 3_000_000,
        originChainId: 1,
        message: "0xabcdef",
        exclusiveRelayer: ZERO_ADDRESS,
        fillDeadline: getCurrentTime() + 600,
        exclusivityDeadline: 0,
      },
      10
    );
    const fillData = await spokePool.queryFilter(spokePool.filters.FilledRelay());
    expect(fillData.length).to.eq(1);
    const onlyMessages = fillData.filter((fill) => !isMessageEmpty(fill.args.messageHash));
    expect(onlyMessages.length).to.eq(1);
    const relevantFill = onlyMessages[0];
    const spreadFill = spreadEvent(relevantFill.args);

    expect({
      ...spreadFill.relayExecutionInfo,
      updatedOutputAmount: spreadFill.relayExecutionInfo.updatedOutputAmount.toString(),
    }).to.deep.eq({
      updatedRecipient: toBytes32(testContract.address).toLowerCase(),
      updatedMessageHash: ethers.utils.keccak256("0xabcdef"),
      updatedOutputAmount: "1",
      fillType: 0,
    });
  });
});

describe("QueryBase", function () {
  describe("estimateGas", function () {
    let queryBase: QueryBase;
    beforeEach(function () {
      queryBase = QueryBase__factory.create(
        1, // chainId
        getDefaultProvider(),
        undefined, // symbolMapping
        undefined, // spokePoolAddress
        undefined, // simulatedRelayerAddress
        undefined,
        this.logger
      );
    });
    it("Uses passed in options", async function () {
      const options = {
        gasUnits: BigNumber.from(300_000),
        gasPrice: toGWei("1.5"),
      };
      const result = await queryBase.estimateGas(
        {}, // populatedTransaction
        randomAddress(),
        getDefaultProvider(),
        options
      );
      expect(result.gasPrice).to.equal(options.gasPrice);
      expect(result.nativeGasCost).to.equal(options.gasUnits);
      expect(result.tokenGasCost).to.equal(options.gasPrice.mul(options.gasUnits));
    });
    it("Queries GasPriceOracle for gasPrice if not supplied", async function () {
      const options = {
        gasUnits: BigNumber.from(300_000),
        gasPrice: undefined,
        baseFeeMultiplier: toBNWei("2"),
      };
      // Mocked provider gets queried to compute gas price.
      const stdLastBaseFeePerGas = toGWei("12");
      const stdMaxPriorityFeePerGas = toGWei("1");
      const chainId = 1; // get gas price from GasPriceOracle.ethereum.eip1559()
      const mockedProvider = new MockedProvider(stdLastBaseFeePerGas, stdMaxPriorityFeePerGas, chainId);

      const result = await queryBase.estimateGas(
        {}, // populatedTransaction
        randomAddress(),
        mockedProvider,
        options
      );
      // In this test, verify that the baseFeeMultiplier is passed correctly to the
      // GasPriceOracle.
      const expectedGasPrice = stdLastBaseFeePerGas
        .mul(options.baseFeeMultiplier)
        .div(fixedPointAdjustment)
        .add(stdMaxPriorityFeePerGas);
      expect(result.gasPrice).to.equal(expectedGasPrice);
      expect(result.nativeGasCost).to.equal(options.gasUnits);
      expect(result.tokenGasCost).to.equal(expectedGasPrice.mul(options.gasUnits));
    });
  });
});
