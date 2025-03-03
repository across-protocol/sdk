import { DEFAULT_CONFIG_STORE_VERSION } from "../src/clients";
import { EvmAddress, Address, bnZero, bnOne, SvmAddress, toWei } from "../src/utils";
import { ZERO_ADDRESS } from "../src/constants";
import {
  expect,
  ethers,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  hubPoolFixture,
  deploySpokePool,
  getContractFactory,
} from "./utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "../src/clients/mocks";

describe("Address Utils: Address Type", function () {
  let owner: SignerWithAddress;
  let chainIds: number[];
  let originChainId, destinationChainId, repaymentChainId: number;
  let hubPoolClient: MockHubPoolClient;
  let spokePoolClient: MockSpokePoolClient;
  let configStoreClient: MockConfigStoreClient;

  const logger = createSpyLogger().spyLogger;
  const random = () => Math.round(Math.random() * 1e6);
  const randomBytes = (n: number): string => ethers.utils.hexlify(ethers.utils.randomBytes(n));

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    const { hubPool } = await hubPoolFixture();

    // Sanity Check: Ensure that owner.provider is defined
    expect(owner.provider).to.not.be.undefined;
    if (owner.provider === undefined) {
      throw new Error("owner.provider is undefined");
    }

    ({ chainId: destinationChainId } = await owner.provider.getNetwork());

    originChainId = random();
    repaymentChainId = random();
    chainIds = [originChainId, destinationChainId, repaymentChainId];

    const mockUpdate = true;
    const { configStore } = await deployConfigStore(owner, []);
    configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      {} as EventSearchConfig,
      DEFAULT_CONFIG_STORE_VERSION,
      undefined,
      mockUpdate,
      chainIds
    );
    await configStoreClient.update();

    const deploymentBlock = await hubPool.provider.getBlockNumber();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient, deploymentBlock, originChainId);
    // hubPoolClient.setReturnedL1TokenForDeposit(ZERO_ADDRESS);
    [originChainId, destinationChainId, repaymentChainId, hubPoolClient.chainId].forEach((chainId) =>
      hubPoolClient.setTokenMapping(EvmAddress.fromHex(ZERO_ADDRESS), chainId, Address.fromHex(ZERO_ADDRESS))
    );
    await hubPoolClient.update();

    const { spokePool } = await deploySpokePool(ethers);
    const receipt = await spokePool.deployTransaction.wait();
    await spokePool.setChainId(originChainId);
    spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, receipt.blockNumber);
  });

  it("Parses Addresses in the SpokePoolClient", async function () {
    // Mappings to check are speedUps and depositRoutes.
    // Set deposit route. Token is an `Address` since it may be 20 or 32 bytes, but our current implementation of the spoke pool client
    // only supports 20 byte addresses, so this check is more for consistency of keys.
    const originToken = Address.fromHex(randomBytes(20));
    spokePoolClient.setEnableRoute(originToken, destinationChainId, true);
    await spokePoolClient.update();
    const depositRoutes = spokePoolClient.getDepositRoutes();

    // The keys should NOT be stored as an address, but they should be stored as a 32 byte hex string.
    expect(ethers.utils.isAddress(Object.keys(depositRoutes)[0])).to.be.false;
    expect(
      ethers.utils.isHexString(Object.keys(depositRoutes)[0]) &&
        ethers.utils.hexDataLength(Object.keys(depositRoutes)[0]) === 32
    ).to.be.true;

    // For SpeedUps, the depositor should also be stored as a 32 byte string.
    const destinationToken = Address.fromHex(randomBytes(32));
    const depositor = Address.fromHex(randomBytes(32));
    const deposit = {
      depositor,
      recipient: depositor,
      inputToken: originToken,
      outputToken: destinationToken,
      inputAmount: bnOne,
      outputAmount: bnOne,
      message: "0x",
      exclusiveRelayer: depositor,
      depositId: bnZero,
      fillDeadline: 10000,
      exclusivityDeadline: 9999,
      destinationChainId,
      quoteTimestamp: 0,
    };
    spokePoolClient.deposit(deposit);
    spokePoolClient.speedUpDeposit({
      ...deposit,
      originChainId,
      depositorSignature: "",
      updatedRecipient: depositor,
      updatedOutputAmount: bnZero,
      updatedMessage: "0x",
    });
    await spokePoolClient.update();
    const speedUps = spokePoolClient.getSpeedUps();
    expect(
      !ethers.utils.isAddress(Object.keys(speedUps)[0]) && ethers.utils.hexDataLength(Object.keys(speedUps)[0]) === 32
    ).to.be.true;
  });

  it("Parses Addresses in the HubPoolClient", async function () {
    // LP Tokens and l1TokensToDestinationTokens should both be 20 byte addresses.
    const originToken = Address.fromHex(randomBytes(20));
    hubPoolClient.setPoolRebalanceRoute(destinationChainId, originToken, originToken);
    await hubPoolClient.update();
    Object.keys(hubPoolClient.getL1TokensToDestinationTokensWithBlock()).forEach((l1Token) => {
      expect(ethers.utils.hexDataLength(l1Token)).to.eq(20);
    });

    // Enable token for liquidity provision.
    const l1Token = await (await getContractFactory("ExpandedERC20", owner)).deploy("", "AA", 6);
    hubPoolClient.enableL1TokenForLiquidityProvision(l1Token.address);
    const castedToken = EvmAddress.fromHex(l1Token.address);
    await hubPoolClient.update();
    expect(hubPoolClient.getLpTokenInfoForL1Token(castedToken)).to.not.be.undefined;
  });

  it("Parses Addresses in the Config Store Client", async function () {
    // Everything in the config store client should be 20 byte addresses.
    const originToken = Address.fromHex(randomBytes(20));
    const sampleRateModel = {
      UBar: toWei("0.65").toString(),
      R0: toWei("0.00").toString(),
      R1: toWei("0.08").toString(),
      R2: toWei("1.00").toString(),
    };
    const sampleSpokeTargetBalances = {
      [originChainId]: {
        target: toWei("100").toString(),
        threshold: toWei("200").toString(),
      },
      [destinationChainId]: {
        target: toWei("50").toString(),
        threshold: toWei("100").toString(),
      },
    };
    const tokenConfigToUpdate = JSON.stringify({
      rateModel: sampleRateModel,
      routeRateModel: { [`${originChainId}-${destinationChainId}`]: sampleRateModel },
      spokeTargetBalances: sampleSpokeTargetBalances,
    });
    await configStoreClient.setConfigStoreVersion(0);
    await configStoreClient.updateTokenConfig(originToken.toAddress(), tokenConfigToUpdate);
    await configStoreClient.update();
    const rateModelUpdate = configStoreClient.getRateModelUpdates();
    Object.values(rateModelUpdate).forEach((update) => expect(update.l1Token instanceof EvmAddress).to.be.true);
    const routeRateModelUpdate = configStoreClient.getRouteRateModelUpdates();
    Object.values(routeRateModelUpdate).forEach((update) => expect(update.l1Token instanceof EvmAddress).to.be.true);
  });

  it("Correctness of Address methods", function () {
    const evmToken = EvmAddress.fromHex(randomBytes(20));
    expect(Address.isAddress(evmToken)).to.be.true;
    expect(evmToken.isValidEvmAddress()).to.be.true;
    expect(ethers.utils.isAddress(evmToken.toAddress())).to.be.true;
    expect(ethers.utils.hexDataLength(evmToken.toString()) === 32).to.be.true;

    const svmToken: SvmAddress = SvmAddress.fromHex(randomBytes(32));
    expect(Address.isAddress(svmToken)).to.be.true;
    expect(ethers.utils.isAddress(svmToken.toString())).to.be.false;
    expect(ethers.utils.isHexString(svmToken.toAddress())).to.be.false;
  });
});
