import { expect } from "chai";
import { Event } from "ethers";
import { random } from "lodash";
import { utils as sdkUtils } from "../src";
import { DEFAULT_CONFIG_STORE_VERSION, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "../src/clients/mocks";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import { DepositWithBlock, FillWithBlock, SlowFillRequest, SlowFillRequestWithBlock } from "../src/interfaces";
import { getCurrentTime, isDefined, randomAddress } from "../src/utils";
import {
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  deploySpokePool,
  ethers,
  fillFromDeposit,
  hubPoolFixture,
  toBNWei,
} from "./utils";

type EventSearchConfig = sdkUtils.EventSearchConfig;

describe("SpokePoolClient: Event Filtering", function () {
  const fundsDepositedEvents = ["FundsDeposited", "V3FundsDeposited"];
  const slowFillRequestedEvents = ["RequestedV3SlowFill"];
  const filledRelayEvents = ["FilledRelay", "FilledV3Relay"];

  let owner: SignerWithAddress;
  let chainIds: number[];
  let originChainId: number, destinationChainId: number, repaymentChainId: number;
  let hubPoolClient: MockHubPoolClient;
  let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
  let originSpokePoolClient: MockSpokePoolClient;
  let destinationSpokePoolClient: MockSpokePoolClient;
  let configStoreClient: MockConfigStoreClient;

  const logger = createSpyLogger().spyLogger;

  const generateV3Deposit = (
    spokePoolClient: MockSpokePoolClient,
    quoteTimestamp?: number,
    inputToken?: string
  ): Event => {
    inputToken ??= randomAddress();
    const message = EMPTY_MESSAGE;
    quoteTimestamp ??= getCurrentTime() - 10;
    return spokePoolClient.depositV3({ destinationChainId, inputToken, message, quoteTimestamp } as DepositWithBlock);
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Sanity Check: Ensure that owner.provider is defined
    expect(owner.provider).to.not.be.undefined;
    if (owner.provider === undefined) {
      throw new Error("owner.provider is undefined");
    }

    ({ chainId: destinationChainId } = await owner.provider.getNetwork());

    originChainId = random(100_000, 1_000_000, false);
    repaymentChainId = random(1_000_001, 2_000_000, false);
    chainIds = [originChainId, destinationChainId, repaymentChainId];

    spokePoolClients = {};

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

    const { hubPool } = await hubPoolFixture();
    const deploymentBlock = await hubPool.provider.getBlockNumber();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient, deploymentBlock, originChainId);
    // hubPoolClient.setReturnedL1TokenForDeposit(ZERO_ADDRESS);
    [originChainId, destinationChainId, repaymentChainId, hubPoolClient.chainId].forEach((chainId) =>
      hubPoolClient.setTokenMapping(ZERO_ADDRESS, chainId, ZERO_ADDRESS)
    );
    await hubPoolClient.update();

    for (const chainId of chainIds) {
      // @dev the underlying chainId will be the same for all three SpokePools.
      const { spokePool } = await deploySpokePool(ethers);
      const receipt = await spokePool.deployTransaction.wait();
      await spokePool.setChainId(chainId);
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, receipt.blockNumber);
      spokePoolClients[chainId] = spokePoolClient;

      for (const destinationChainId of chainIds) {
        // For each SpokePool, construct routes to each _other_ SpokePool.
        if (destinationChainId === chainId) {
          continue;
        }

        // @todo: destinationToken
        [ZERO_ADDRESS].forEach((originToken) => {
          spokePoolClient.setEnableRoute(originToken, destinationChainId, true);
          hubPoolClient.setPoolRebalanceRoute(destinationChainId, originToken, originToken);
        });
      }
    }
    await hubPoolClient.update();

    originSpokePoolClient = spokePoolClients[originChainId];
    destinationSpokePoolClient = spokePoolClients[destinationChainId];
  });

  it("Correctly retrieves V3FundsDeposited events", async function () {
    // Inject a series of V3DepositWithBlock events.
    const depositEvents: Event[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      depositEvents.push(generateV3Deposit(originSpokePoolClient));
    }
    await originSpokePoolClient.update(fundsDepositedEvents);

    // Should receive _all_ deposits submitted on originChainId.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(depositEvents.length);

    deposits.forEach((depositEvent, idx) => {
      const expectedDeposit = depositEvents[idx];
      expect(depositEvent.blockNumber).to.equal(expectedDeposit.blockNumber);

      const expectedInputToken = expectedDeposit.args!.inputToken;
      expect(depositEvent.inputToken).to.equal(expectedInputToken);
    });
  });

  it("Correctly sets the `fromLiteChain` flag by using `isOriginLiteChain`", async function () {
    // Update the config store to set the originChainId as a lite chain.
    configStoreClient.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([originChainId])
    );
    await configStoreClient.update();
    // Update the config store to set the originChainId as a non-lite chain.
    configStoreClient.updateGlobalConfig(GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES, JSON.stringify([]));
    await configStoreClient.update();

    // Confirm that the config store client has two updates.
    expect(configStoreClient.liteChainIndicesUpdates.length).to.equal(2);
    const [liteChainIndicesUpdate1, liteChainIndicesUpdate2] = configStoreClient.liteChainIndicesUpdates;

    // There's a nuanced issue with the mock config store's event manager so we need to mock a 2 second delay
    // so that the block timestamps are different. If this issue is resolved, this shouldn't impact this test
    // because the second event's timestamp should be greater than the first event's timestamp anyway.
    configStoreClient.liteChainIndicesUpdates[1].timestamp += 2;

    // Confirm that the two updates have different timestamps.
    expect(liteChainIndicesUpdate1.timestamp).to.not.equal(liteChainIndicesUpdate2.timestamp);

    // Inject a V3DepositWithBlock event that should have the `fromLiteChain` flag set to false.
    // This is done by setting the quote timestamp to before the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a V3DepositWithBlock event that should have the `fromLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a V3DepositWithBlock event that should have the `fromLiteChain` flag set to false.
    // This is done by setting the quote timestamp to after the second lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate2.timestamp + 1);

    // Set the config store client on the originSpokePoolClient so that it can access the lite chain indices updates.
    originSpokePoolClient.setConfigStoreClient(configStoreClient);
    await originSpokePoolClient.update(["V3FundsDeposited"]);

    // Of the three deposits, the first and third should have the `fromLiteChain` flag set to false.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(3);
    expect(deposits[0].fromLiteChain).to.equal(false);
    expect(deposits[1].fromLiteChain).to.equal(true);
    expect(deposits[2].fromLiteChain).to.equal(false);
  });

  it("Correctly sets the `toLiteChain` flag by using `isDestinationLiteChain`", async function () {
    // Update the config store to set the originChainId as a lite chain.
    configStoreClient.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([destinationChainId])
    );
    await configStoreClient.update();
    // Update the config store to set the originChainId as a non-lite chain.
    configStoreClient.updateGlobalConfig(GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES, JSON.stringify([]));
    await configStoreClient.update();

    // Confirm that the config store client has two updates.
    expect(configStoreClient.liteChainIndicesUpdates.length).to.equal(2);
    const [liteChainIndicesUpdate1, liteChainIndicesUpdate2] = configStoreClient.liteChainIndicesUpdates;

    // There's a nuanced issue with the mock config store's event manager so we need to mock a 2 second delay
    // so that the block timestamps are different. If this issue is resolved, this shouldn't impact this test
    // because the second event's timestamp should be greater than the first event's timestamp anyway.
    configStoreClient.liteChainIndicesUpdates[1].timestamp += 2;

    // Confirm that the two updates have different timestamps.
    expect(liteChainIndicesUpdate1.timestamp).to.not.equal(liteChainIndicesUpdate2.timestamp);

    // Inject a V3DepositWithBlock event that should have the `toLiteChain` flag set to false.
    // This is done by setting the quote timestamp to before the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a V3DepositWithBlock event that should have the `toLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a V3DepositWithBlock event that should have the `toLiteChain` flag set to false.
    // This is done by setting the quote timestamp to after the second lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate2.timestamp + 1);

    // Set the config store client on the originSpokePoolClient so that it can access the lite chain indices updates.
    originSpokePoolClient.setConfigStoreClient(configStoreClient);
    await originSpokePoolClient.update(["V3FundsDeposited"]);

    // Of the three deposits, the first and third should have the `toLiteChain` flag set to false.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(3);
    expect(deposits[0].toLiteChain).to.equal(false);
    expect(deposits[1].toLiteChain).to.equal(true);
    expect(deposits[2].toLiteChain).to.equal(false);
  });

  it("Correctly substitutes outputToken when set to 0x0", async function () {
    const { spokePool, chainId, deploymentBlock } = originSpokePoolClient;
    const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, deploymentBlock, { hubPoolClient });

    const hubPoolToken = randomAddress();
    const inputToken = randomAddress();
    const outputToken = randomAddress();
    hubPoolClient.setTokenMapping(hubPoolToken, originChainId, inputToken);
    hubPoolClient.setTokenMapping(hubPoolToken, destinationChainId, outputToken);
    hubPoolClient.setDefaultRealizedLpFeePct(toBNWei("0.0001"));

    const _deposit = spokePoolClient.depositV3({
      originChainId,
      destinationChainId,
      inputToken,
      outputToken: ZERO_ADDRESS, // outputToken must _not_ be ZERO_ADDRESS after SpokePoolClient ingestion.
    } as DepositWithBlock);
    expect(_deposit?.args?.outputToken).to.equal(ZERO_ADDRESS);

    await spokePoolClient.update(fundsDepositedEvents);

    const [deposit] = spokePoolClient.getDeposits();
    expect(deposit).to.exist;

    expect(deposit.inputToken).to.equal(inputToken);
    expect(deposit.outputToken).to.not.equal(ZERO_ADDRESS);
    expect(deposit.outputToken).to.equal(outputToken);
  });

  it("Correctly retrieves SlowFillRequested events", async function () {
    const requests: Event[] = [];

    const slowFillRequestFromDeposit = (deposit: DepositWithBlock): SlowFillRequest => {
      const { blockNumber, ...partialDeposit } = deposit;
      return { ...partialDeposit };
    };

    for (let idx = 0; idx < 10; ++idx) {
      const depositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.not.be.undefined;
      deposit = deposit!;

      expect(deposit.depositId).to.equal(depositEvent.args!.depositId);

      const slowFillRequest = slowFillRequestFromDeposit(deposit);
      requests.push(destinationSpokePoolClient.requestV3SlowFill(slowFillRequest as SlowFillRequestWithBlock));
    }
    await destinationSpokePoolClient.update(slowFillRequestedEvents);

    // Should receive _all_ fills submitted on the destination chain.
    requests.forEach((event) => {
      let { args } = event;
      expect(args).to.not.be.undefined;
      args = args!;

      const relayData = {
        depositId: args.depositId,
        originChainId: args.originChainId,
        depositor: args.depositor,
        recipient: args.recipient,
        inputToken: args.inputToken,
        inputAmount: args.inputAmount,
        outputToken: args.outputToken,
        outputAmount: args.outputAmount,
        message: args.message,
        fillDeadline: args.fillDeadline,
        exclusiveRelayer: args.exclusiveRelayer,
        exclusivityDeadline: args.exclusivityDeadline,
      };

      const slowFillRequest = destinationSpokePoolClient.getSlowFillRequest(relayData);
      expect(slowFillRequest).to.not.be.undefined;

      // The SpokePoolClient appends destinationChainId, so check for it specifically.
      expect(slowFillRequest?.destinationChainId).to.not.be.undefined;
      expect(slowFillRequest?.destinationChainId).to.equal(destinationChainId);
      Object.entries(relayData).forEach(
        ([k, v]) => expect(isDefined(v)).to.equal(true) && expect(slowFillRequest?.[k]).to.equal(v)
      );
    });
  });

  it("Correctly retrieves FilledV3Relay events", async function () {
    // Inject a series of v2DepositWithBlock and v3DepositWithBlock events.
    const fillEvents: Event[] = [];
    const relayer = randomAddress();

    for (let idx = 0; idx < 10; ++idx) {
      const v3DepositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.not.be.undefined;
      deposit = deposit!;
      expect(deposit.depositId).to.equal(v3DepositEvent.args!.depositId);

      const v3Fill = fillFromDeposit(deposit, relayer);
      fillEvents.push(destinationSpokePoolClient.fillV3Relay(v3Fill as FillWithBlock));
    }
    await destinationSpokePoolClient.update(filledRelayEvents);

    // Should receive _all_ fills submitted on the destination chain.
    const fills = destinationSpokePoolClient.getFills();
    expect(fills.length).to.equal(fillEvents.length);

    fills.forEach((fillEvent, idx) => {
      const expectedFill = fillEvents[idx];

      expect(fillEvent.blockNumber).to.equal(expectedFill.blockNumber);

      // destinationChainId is appended by the SpokePoolClient for V3FundsDeposited events, so verify its correctness.
      expect(fillEvent.destinationChainId).to.equal(destinationChainId);
      expect(fillEvent.outputToken).to.equal(expectedFill.args!.outputToken);
    });
  });
});
