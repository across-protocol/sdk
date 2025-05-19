import { expect } from "chai";
import { utils as sdkUtils } from "../src";
import { DEFAULT_CONFIG_STORE_VERSION, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "../src/clients/mocks";
import { ZERO_ADDRESS } from "../src/constants";
import {
  DepositWithBlock,
  FillWithBlock,
  Log,
  SlowFillRequest,
  SlowFillRequestWithBlock,
  SpeedUp,
  TokensBridged,
} from "../src/interfaces";
import { bnOne, getCurrentTime, getMessageHash, isDefined, randomAddress, toAddress, toBN } from "../src/utils";
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
  const random = () => Math.round(Math.random() * 1e6);
  const randomBytes = (n: number): string => ethers.utils.hexlify(ethers.utils.randomBytes(n));
  const destinationToken = randomAddress();

  const fundsDepositedEvents = ["FundsDeposited", "V3FundsDeposited"];
  const slowFillRequestedEvents = ["RequestedSlowFill", "RequestedV3SlowFill"];
  const speedUpEvents = ["RequestedSpeedUpDeposit", "RequestedSpeedUpV3Deposit"];
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
  ): Log => {
    inputToken ??= randomAddress();
    const message = randomBytes(32);
    quoteTimestamp ??= getCurrentTime() - 10;
    return spokePoolClient.depositV3({ destinationChainId, inputToken, message, quoteTimestamp } as DepositWithBlock);
  };

  const generateDeposit = (spokePoolClient: MockSpokePoolClient, quoteTimestamp?: number, inputToken?: string): Log => {
    inputToken ??= randomAddress();
    const message = randomBytes(32);
    quoteTimestamp ??= getCurrentTime() - 10;
    return spokePoolClient.deposit({ destinationChainId, inputToken, message, quoteTimestamp } as DepositWithBlock);
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Sanity Check: Ensure that owner.provider is defined
    expect(owner.provider).to.not.be.undefined;
    if (owner.provider === undefined) {
      throw new Error("owner.provider is undefined");
    }

    ({ chainId: destinationChainId } = await owner.provider.getNetwork());

    originChainId = random();
    repaymentChainId = random();
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

        [destinationToken].forEach((originToken) => {
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
    // Inject a series of DepositWithBlock events.
    const depositEvents: Log[] = [];

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

  it("Maps multiple fills for same deposit ID + origin chain ID to same deposit", async function () {
    const depositEvent = generateV3Deposit(originSpokePoolClient);
    await originSpokePoolClient.update(fundsDepositedEvents);
    let deposit = originSpokePoolClient.getDeposits().at(-1);
    expect(deposit).to.exist;
    deposit = deposit!;
    expect(deposit.depositId).to.equal(depositEvent.args!.depositId);

    // Mock invalid fills:
    destinationSpokePoolClient.fillV3Relay(
      fillFromDeposit({ ...deposit, exclusivityDeadline: deposit.exclusivityDeadline + 2 }, randomAddress())
    );
    destinationSpokePoolClient.fillV3Relay(
      fillFromDeposit({ ...deposit, exclusivityDeadline: deposit.exclusivityDeadline + 1 }, randomAddress())
    );
    await destinationSpokePoolClient.update(filledRelayEvents);

    const fillsForDeposit = destinationSpokePoolClient.getFillsForDeposit(deposit);
    expect(fillsForDeposit.length).to.equal(2);
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

    // Inject a DepositWithBlock event that should have the `fromLiteChain` flag set to false.
    // This is done by setting the quote timestamp to before the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a DepositWithBlock event that should have the `fromLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a DepositWithBlock event that should have the `fromLiteChain` flag set to false.
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

    // Inject a DepositWithBlock event that should have the `toLiteChain` flag set to false.
    // This is done by setting the quote timestamp to before the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a DepositWithBlock event that should have the `toLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateV3Deposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a DepositWithBlock event that should have the `toLiteChain` flag set to false.
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

  it("Handles case where outputToken is set to 0x0 and cannot be resolved", async function () {
    const { spokePool, chainId, deploymentBlock } = originSpokePoolClient;
    const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, deploymentBlock, { hubPoolClient });

    const hubPoolToken = randomAddress();
    const outputToken = randomAddress();
    const inputToken = randomAddress();
    hubPoolClient.setDefaultRealizedLpFeePct(toBNWei("0.0001"));

    const _deposit = spokePoolClient.depositV3({
      originChainId,
      destinationChainId,
      inputToken,
      outputToken: ZERO_ADDRESS,
    } as DepositWithBlock);
    expect(_deposit?.args?.outputToken).to.equal(ZERO_ADDRESS);

    await spokePoolClient.update(fundsDepositedEvents);

    const [deposit] = spokePoolClient.getDeposits();
    expect(deposit).to.exist;
    expect(deposit.outputToken).to.equal(ZERO_ADDRESS);

    // Both origin and destination chains must map to the PoolRebalanceRoute of the inputToken:
    hubPoolClient.setTokenMapping(hubPoolToken, originChainId, inputToken);
    await spokePoolClient.update(fundsDepositedEvents);
    expect(spokePoolClient.getDeposits()[0].outputToken).to.equal(ZERO_ADDRESS);
    hubPoolClient.deleteTokenMapping(hubPoolToken, originChainId);
    hubPoolClient.setTokenMapping(hubPoolToken, destinationChainId, outputToken);
    await spokePoolClient.update(fundsDepositedEvents);
    expect(spokePoolClient.getDeposits()[0].outputToken).to.equal(ZERO_ADDRESS);
  });

  it("Correctly retrieves SlowFillRequested events", async function () {
    const requests: Log[] = [];

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

    // Should receive _all_ slow fills submitted on the destination chain.
    const slowFillRequests = destinationSpokePoolClient.getSlowFillRequests();
    expect(slowFillRequests.length).to.equal(requests.length);

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
    const fillEvents: Log[] = [];
    const relayer = randomAddress();

    for (let idx = 0; idx < 10; ++idx) {
      const depositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;
      expect(deposit.depositId).to.equal(depositEvent.args!.depositId);

      const v3Fill = fillFromDeposit(deposit, relayer);
      fillEvents.push(destinationSpokePoolClient.fillV3Relay(v3Fill as FillWithBlock & { message: string }));
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

  it("Correctly truncates events with bytes32 address fields: TokensBridged", async function () {
    for (let i = 0; i < 10; ++i) {
      const l2TokenAddress = ethers.utils.hexZeroPad(randomAddress(), 32);
      originSpokePoolClient.setTokensBridged({ l2TokenAddress, chainId: i, leafId: i + 1 } as TokensBridged);
      await originSpokePoolClient.update(["TokensBridged"]);
      let tokensBridged = originSpokePoolClient.getTokensBridged().at(-1);
      expect(tokensBridged).to.exist;
      tokensBridged = tokensBridged!;

      expect(tokensBridged.l2TokenAddress).to.equal(toAddress(l2TokenAddress));
    }
  });

  it("Correctly truncates events with bytes32 address fields: FundsDeposited", async function () {
    for (let _i = 0; _i < 10; ++_i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer] = Array(5)
        .fill(0)
        .map((_) => ethers.utils.hexZeroPad(randomAddress(), 32));
      originSpokePoolClient.depositV3({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
      } as DepositWithBlock);
      await originSpokePoolClient.update(["V3FundsDeposited"]);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;

      expect(deposit.depositor).to.equal(toAddress(depositor));
      expect(deposit.recipient).to.equal(toAddress(recipient));
      expect(deposit.inputToken).to.equal(toAddress(inputToken));
      expect(deposit.outputToken).to.equal(toAddress(outputToken));
      expect(deposit.exclusiveRelayer).to.equal(toAddress(exclusiveRelayer));
    }
  });
  it("Correctly truncates events with bytes32 address fields: RequestedSpeedUpDeposit", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, updatedRecipient] = Array(2)
        .fill(0)
        .map((_) => ethers.utils.hexZeroPad(randomAddress(), 32));
      originSpokePoolClient.speedUpV3Deposit({ depositor, updatedRecipient, depositId: toBN(i) } as SpeedUp);
      await originSpokePoolClient.update(["RequestedSpeedUpV3Deposit"]);
      let speedUp = originSpokePoolClient.getSpeedUps()[toAddress(depositor)][toBN(i).toString()].at(-1);
      expect(speedUp).to.exist;
      speedUp = speedUp!;

      expect(speedUp.depositor).to.equal(toAddress(depositor));
      expect(speedUp.updatedRecipient).to.equal(toAddress(updatedRecipient));
    }
  });
  it("Correctly truncates events with bytes32 address fields: FilledRelay", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer, relayer] = Array(6)
        .fill(0)
        .map((_) => ethers.utils.hexZeroPad(randomAddress(), 32));
      originSpokePoolClient.fillV3Relay({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        relayer,
        depositId: toBN(i),
      } as FillWithBlock & { message: string });
      await originSpokePoolClient.update(["FilledV3Relay"]);
      let relay = originSpokePoolClient.getFills().at(-1);
      expect(relay).to.exist;
      relay = relay!;

      expect(relay.depositor).to.equal(toAddress(depositor));
      expect(relay.recipient).to.equal(toAddress(recipient));
      expect(relay.inputToken).to.equal(toAddress(inputToken));
      expect(relay.outputToken).to.equal(toAddress(outputToken));
      expect(relay.exclusiveRelayer).to.equal(toAddress(exclusiveRelayer));
      expect(relay.relayer).to.equal(toAddress(relayer));
    }
  });
  it("Correctly truncates events with bytes32 address fields: RequestedSlowFill", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer] = Array(5)
        .fill(0)
        .map((_) => ethers.utils.hexZeroPad(randomAddress(), 32));
      originSpokePoolClient.requestV3SlowFill({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        depositId: toBN(i),
        originChainId: 1,
        inputAmount: toBN(i),
        outputAmount: toBN(i),
        message: "0x",
        fillDeadline: 0,
        exclusivityDeadline: 0,
      } as SlowFillRequestWithBlock);
      await originSpokePoolClient.update(["RequestedV3SlowFill"]);
      let slowFill = originSpokePoolClient.getSlowFillRequestsForOriginChain(1).at(-1);
      expect(slowFill).to.exist;
      slowFill = slowFill!;

      expect(slowFill.depositor).to.equal(toAddress(depositor));
      expect(slowFill.recipient).to.equal(toAddress(recipient));
      expect(slowFill.inputToken).to.equal(toAddress(inputToken));
      expect(slowFill.outputToken).to.equal(toAddress(outputToken));
      expect(slowFill.exclusiveRelayer).to.equal(toAddress(exclusiveRelayer));
    }
  });
  it("Does not throw when processing a bytes32 address", async function () {
    const random = () => Math.round(Math.random() * 1e6);
    const randomBytes = (n: number): string => ethers.utils.hexlify(ethers.utils.randomBytes(n));

    for (let i = 0; i < 10; ++i) {
      const [
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        relayer,
        updatedRecipient,
        l2TokenAddress,
      ] = Array(8).fill(0).map(randomAddress);

      const common = {
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        depositId: toBN(i),
        quoteTimestamp: random(),
        originChainId,
        destinationChainId,
        fillDeadline: random(),
        exclusivityDeadline: random(),
        fromLiteChain: false,
        toLiteChain: false,
        inputAmount: toBN(random()),
        outputAmount: toBN(random()),
      };

      const relayExecutionInfo = {
        updatedRecipient,
        updatedOutputAmount: common.outputAmount,
        updatedMessage: randomBytes(32),
        depositorSignature: randomBytes(32),
      };

      // Deposit
      originSpokePoolClient.deposit({ ...common, message: randomBytes(32) });

      // SpeedUpDeposit
      originSpokePoolClient.speedUpDeposit({
        originChainId,
        depositId: toBN(i),
        depositor,
        updatedRecipient,
        updatedOutputAmount: common.outputAmount.sub(bnOne),
        updatedMessage: randomBytes(32),
        depositorSignature: randomBytes(32),
      });

      // FillV3Relay
      originSpokePoolClient.fillRelay({
        ...common,
        repaymentChainId: random(),
        message: randomBytes(32),
        relayer,
        relayExecutionInfo: {
          ...relayExecutionInfo,
          updatedMessageHash: getMessageHash(randomBytes(32)),
          fillType: 0,
        },
      });

      // TokensBridged
      originSpokePoolClient.setTokensBridged({
        l2TokenAddress,
        chainId: i,
        leafId: i + 1,
        amountToReturn: toBN(random()),
        blockNumber: random(),
        txnRef: randomBytes(32),
        txnIndex: random(),
        logIndex: random(),
      });

      // RequestV3SlowFill
      destinationSpokePoolClient.requestSlowFill({ ...common, message: randomBytes(32) });

      await originSpokePoolClient.update([
        ...fundsDepositedEvents,
        ...filledRelayEvents,
        ...speedUpEvents,
        ...slowFillRequestedEvents,
        "TokensBridged",
      ]);

      await destinationSpokePoolClient.update([...filledRelayEvents, ...slowFillRequestedEvents]);

      let slowFill = destinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).at(-1);
      expect(slowFill).to.exist;
      slowFill = slowFill!;

      let tokensBridged = originSpokePoolClient.getTokensBridged().at(-1);
      expect(tokensBridged).to.exist;
      tokensBridged = tokensBridged!;

      let speedUp = originSpokePoolClient.getSpeedUps()[depositor]?.[common.depositId.toString()]?.at(-1);
      expect(speedUp).to.exist;
      speedUp = speedUp!;

      let relay = originSpokePoolClient.getFills().at(-1);
      expect(relay).to.exist;
      relay = relay!;

      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;

      // SlowFill
      expect(slowFill.depositor).to.equal(depositor);
      expect(slowFill.recipient).to.equal(recipient);
      expect(slowFill.inputToken).to.equal(inputToken);
      expect(slowFill.outputToken).to.equal(outputToken);
      expect(slowFill.exclusiveRelayer).to.equal(exclusiveRelayer);

      // Relay
      expect(relay.depositor).to.equal(depositor);
      expect(relay.recipient).to.equal(recipient);
      expect(relay.inputToken).to.equal(inputToken);
      expect(relay.outputToken).to.equal(outputToken);
      expect(relay.exclusiveRelayer).to.equal(exclusiveRelayer);
      expect(relay.relayer).to.equal(relayer);

      // SpeedUp
      expect(speedUp.depositor).to.equal(depositor);
      expect(speedUp.updatedRecipient).to.equal(updatedRecipient);

      // Deposit
      expect(deposit.depositor).to.equal(depositor);
      expect(deposit.recipient).to.equal(recipient);
      expect(deposit.inputToken).to.equal(inputToken);
      expect(deposit.outputToken).to.equal(outputToken);
      expect(deposit.exclusiveRelayer).to.equal(exclusiveRelayer);

      // TokensBridged
      expect(tokensBridged.l2TokenAddress).to.equal(l2TokenAddress);
    }
  });

  describe("SpokePoolClient: Legacy messageHash Handling", function () {
    it("Correctly appends messageHash", async function () {
      for (const event of ["FundsDeposited", "V3FundsDeposited"]) {
        const depositGenerator = event === "V3FundsDeposited" ? generateV3Deposit : generateDeposit;
        const _deposit = depositGenerator(originSpokePoolClient);
        expect(_deposit?.args?.messageHash).to.equal(undefined);
        await originSpokePoolClient.update(fundsDepositedEvents);

        let deposit = originSpokePoolClient.getDeposit(_deposit.args.depositId);
        expect(deposit).to.exist;
        deposit = deposit!;

        // Both event types should include messageHash.
        expect(deposit.messageHash).to.equal(getMessageHash(deposit.message));
      }
    });

    it("Correctly appends RequestedV3SlowFill messageHash", async function () {
      for (const event of ["RequestedSlowFill", "RequestedV3SlowFill"]) {
        const depositGenerator = event === "RequestedV3SlowFill" ? generateV3Deposit : generateDeposit;
        const _deposit = depositGenerator(originSpokePoolClient);
        expect(_deposit?.args?.messageHash).to.equal(undefined);
        await originSpokePoolClient.update(fundsDepositedEvents);

        let deposit = originSpokePoolClient.getDeposit(_deposit.args.depositId);
        expect(deposit).to.exist;
        deposit = deposit!;

        if (event === "RequestedV3SlowFill") {
          destinationSpokePoolClient.requestV3SlowFill({ ...deposit, blockNumber: undefined });
        } else {
          destinationSpokePoolClient.requestSlowFill({ ...deposit, blockNumber: undefined });
        }
        await destinationSpokePoolClient.update(slowFillRequestedEvents);

        let slowFillRequest = destinationSpokePoolClient.getSlowFillRequest(deposit);
        expect(slowFillRequest).to.exist;
        slowFillRequest = slowFillRequest!;

        expect(slowFillRequest.messageHash).to.equal(getMessageHash(deposit.message));
      }
    });

    it("Correctly appends RequestedSpeedUpDeposit messageHash", async function () {
      for (const event of ["RequestedSpeedUpDeposit", "RequestedSpeedUpV3Deposit"]) {
        const depositGenerator = event === "RequestedSpeedUpV3Deposit" ? generateV3Deposit : generateDeposit;
        const _deposit = depositGenerator(originSpokePoolClient);
        expect(_deposit?.args?.messageHash).to.equal(undefined);
        await originSpokePoolClient.update(fundsDepositedEvents);

        let deposit = originSpokePoolClient.getDeposit(_deposit.args.depositId);
        expect(deposit).to.exist;
        deposit = deposit!;

        const speedUp = {
          ...deposit,
          updatedMessage: deposit.message,
          updatedOutputAmount: deposit.outputAmount.sub(bnOne),
          updatedRecipient: deposit.recipient,
          depositorSignature: randomBytes(32),
        };

        if (event === "RequestedSpeedUpV3Deposit") {
          originSpokePoolClient.speedUpV3Deposit(speedUp);
        } else {
          originSpokePoolClient.speedUpDeposit(speedUp);
        }
        await originSpokePoolClient.update(speedUpEvents);

        let updatedDeposit = originSpokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit);
        expect(updatedDeposit).to.exist;
        updatedDeposit = updatedDeposit!;

        expect(updatedDeposit.updatedMessage).to.equal(speedUp.updatedMessage);
        expect(updatedDeposit.updatedRecipient).to.equal(speedUp.updatedRecipient);
        expect(updatedDeposit.updatedOutputAmount).to.equal(speedUp.updatedOutputAmount);
        expect(updatedDeposit.speedUpSignature).to.equal(speedUp.depositorSignature);
      }
    });

    it("Correctly appends FilledV3Relay messageHash", async function () {
      for (const event of ["FundsDeposited", "V3FundsDeposited"]) {
        const depositGenerator = event === "V3FundsDeposited" ? generateV3Deposit : generateDeposit;
        const _deposit = depositGenerator(originSpokePoolClient);
        expect(_deposit?.args?.messageHash).to.equal(undefined);
        await originSpokePoolClient.update(fundsDepositedEvents);

        let deposit = originSpokePoolClient.getDeposit(_deposit.args.depositId);
        expect(deposit).to.exist;
        deposit = deposit!;

        const relayer = randomAddress();

        await destinationSpokePoolClient.update();
        let [fill] = destinationSpokePoolClient.getFillsForRelayer(relayer);
        expect(fill).to.not.exist;

        if (event === "V3FundsDeposited") {
          destinationSpokePoolClient.fillV3Relay(fillFromDeposit(deposit, relayer));
        } else {
          destinationSpokePoolClient.fillRelay(fillFromDeposit(deposit, relayer));
        }
        await destinationSpokePoolClient.update(filledRelayEvents);

        [fill] = destinationSpokePoolClient.getFillsForRelayer(relayer);
        expect(fill).to.exist;
        fill = fill!;

        expect(fill.messageHash).to.equal(getMessageHash(deposit.message));

        const { relayExecutionInfo } = fill;
        expect(relayExecutionInfo).to.exist;

        if (event === "V3FundsDeposited") {
          expect(relayExecutionInfo.updatedMessage).to.exist;
        } else {
          expect(relayExecutionInfo.updatedMessage).to.not.exist;
        }

        expect(relayExecutionInfo.updatedMessageHash).to.exist;
        expect(relayExecutionInfo.updatedMessageHash).to.equal(getMessageHash(deposit.message));
      }
    });
  });
});
