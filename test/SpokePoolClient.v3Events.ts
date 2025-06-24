import { expect } from "chai";
import { utils as sdkUtils } from "../src";
import { DEFAULT_CONFIG_STORE_VERSION, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "../src/clients/mocks";
import { ZERO_ADDRESS, ZERO_BYTES } from "../src/constants";
import { DepositWithBlock, FillWithBlock, Log, SlowFillRequest, SpeedUp, TokensBridged } from "../src/interfaces";
import {
  Address,
  bnOne,
  EvmAddress,
  getCurrentTime,
  getMessageHash,
  isDefined,
  randomAddress,
  toAddressType,
  toEvmAddress,
  toBN,
  toBytes32,
} from "../src/utils";
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

  const fundsDepositedEvents = ["FundsDeposited"];
  const slowFillRequestedEvents = ["RequestedSlowFill"];
  const speedUpEvents = ["RequestedSpeedUpDeposit"];
  const filledRelayEvents = ["FilledRelay"];

  let owner: SignerWithAddress;
  let chainIds: number[];
  let originChainId: number, destinationChainId: number, repaymentChainId: number;
  let hubPoolClient: MockHubPoolClient;
  let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
  let originSpokePoolClient: MockSpokePoolClient;
  let destinationSpokePoolClient: MockSpokePoolClient;
  let configStoreClient: MockConfigStoreClient;

  const logger = createSpyLogger().spyLogger;

  const generateDeposit = (
    spokePoolClient: MockSpokePoolClient,
    quoteTimestamp?: number,
    inputToken?: Address
  ): Log => {
    inputToken ??= toAddressType(randomAddress(), originChainId);
    const message = randomBytes(32);
    quoteTimestamp ??= getCurrentTime() - 10;
    return spokePoolClient.deposit({ destinationChainId, inputToken, message, quoteTimestamp } as DepositWithBlock);
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Sanity Check: Ensure that owner.provider is defined
    expect(owner.provider).to.exist;
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

  it("Correctly retrieves FundsDeposited events", async function () {
    // Inject a series of DepositWithBlock events.
    const depositEvents: Log[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      depositEvents.push(generateDeposit(originSpokePoolClient));
    }
    await originSpokePoolClient.update(fundsDepositedEvents);

    // Should receive _all_ deposits submitted on originChainId.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(depositEvents.length);

    deposits.forEach((depositEvent, idx) => {
      const expectedDeposit = depositEvents[idx];
      expect(depositEvent.blockNumber).to.equal(expectedDeposit.blockNumber);

      const expectedInputToken = toAddressType(expectedDeposit.args.inputToken, originChainId);
      expect(depositEvent.inputToken.eq(expectedInputToken)).to.be.true;
    });
  });

  it("Maps multiple fills for same deposit ID + origin chain ID to same deposit", async function () {
    const depositEvent = generateDeposit(originSpokePoolClient);
    await originSpokePoolClient.update(fundsDepositedEvents);
    let deposit = originSpokePoolClient.getDeposits().at(-1);
    expect(deposit).to.exist;
    deposit = deposit!;
    expect(deposit.depositId).to.equal(depositEvent.args!.depositId);

    // Mock invalid fills:
    destinationSpokePoolClient.fillRelay(
      fillFromDeposit(
        { ...deposit, exclusivityDeadline: deposit.exclusivityDeadline + 2 },
        toAddressType(randomAddress(), destinationChainId)
      )
    );
    destinationSpokePoolClient.fillRelay(
      fillFromDeposit(
        { ...deposit, exclusivityDeadline: deposit.exclusivityDeadline + 1 },
        toAddressType(randomAddress(), destinationChainId)
      )
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
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a DepositWithBlock event that should have the `fromLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a DepositWithBlock event that should have the `fromLiteChain` flag set to false.
    // This is done by setting the quote timestamp to after the second lite chain update.
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate2.timestamp + 1);

    // Set the config store client on the originSpokePoolClient so that it can access the lite chain indices updates.
    originSpokePoolClient.setConfigStoreClient(configStoreClient);
    await originSpokePoolClient.update(fundsDepositedEvents);

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
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp - 1);
    // Inject a DepositWithBlock event that should have the `toLiteChain` flag set to true.
    // This is done by setting the quote timestamp to after the first lite chain update.
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate1.timestamp + 1);
    // Inject a DepositWithBlock event that should have the `toLiteChain` flag set to false.
    // This is done by setting the quote timestamp to after the second lite chain update.
    generateDeposit(originSpokePoolClient, liteChainIndicesUpdate2.timestamp + 1);

    // Set the config store client on the originSpokePoolClient so that it can access the lite chain indices updates.
    originSpokePoolClient.setConfigStoreClient(configStoreClient);
    await originSpokePoolClient.update(fundsDepositedEvents);

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

    const _deposit = spokePoolClient.deposit({
      originChainId,
      destinationChainId,
      inputToken: toAddressType(inputToken, originChainId),
      outputToken: toAddressType(ZERO_ADDRESS, destinationChainId), // outputToken must _not_ be ZERO_ADDRESS after SpokePoolClient ingestion.
    } as DepositWithBlock);
    expect(_deposit?.args?.outputToken).to.equal(toBytes32(ZERO_ADDRESS));

    await spokePoolClient.update(fundsDepositedEvents);

    const [deposit] = spokePoolClient.getDeposits();
    expect(deposit).to.exist;

    expect(deposit.inputToken.toNative()).to.equal(inputToken);
    expect(deposit.outputToken.toNative()).to.not.equal(ZERO_ADDRESS);
    expect(deposit.outputToken.toNative()).to.equal(outputToken);
  });

  it("Handles case where outputToken is set to 0x0 and cannot be resolved", async function () {
    const { spokePool, chainId, deploymentBlock } = originSpokePoolClient;
    const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, deploymentBlock, { hubPoolClient });

    const hubPoolToken = randomAddress();
    const outputToken = randomAddress();
    const inputToken = randomAddress();
    hubPoolClient.setDefaultRealizedLpFeePct(toBNWei("0.0001"));

    const _deposit = spokePoolClient.deposit({
      originChainId,
      destinationChainId,
      inputToken: toAddressType(inputToken, originChainId),
      outputToken: toAddressType(ZERO_ADDRESS, destinationChainId),
    } as DepositWithBlock);
    expect(_deposit?.args?.outputToken).to.equal(ZERO_BYTES);

    await spokePoolClient.update(fundsDepositedEvents);

    const [deposit] = spokePoolClient.getDeposits();
    expect(deposit).to.exist;
    expect(deposit.outputToken.toNative()).to.equal(ZERO_ADDRESS);

    // Both origin and destination chains must map to the PoolRebalanceRoute of the inputToken:
    hubPoolClient.setTokenMapping(hubPoolToken, originChainId, inputToken);
    await spokePoolClient.update(fundsDepositedEvents);
    expect(spokePoolClient.getDeposits()[0].outputToken.toNative()).to.equal(ZERO_ADDRESS);
    hubPoolClient.deleteTokenMapping(hubPoolToken, originChainId);
    hubPoolClient.setTokenMapping(hubPoolToken, destinationChainId, outputToken);
    await spokePoolClient.update(fundsDepositedEvents);
    expect(spokePoolClient.getDeposits()[0].outputToken.toNative()).to.equal(ZERO_ADDRESS);
  });

  it("Correctly retrieves SlowFillRequested events", async function () {
    const requests: Log[] = [];

    const slowFillRequestFromDeposit = (deposit: DepositWithBlock): SlowFillRequest => {
      const { blockNumber, message, ...partialDeposit } = deposit;
      return { ...partialDeposit, messageHash: getMessageHash(message) };
    };

    for (let idx = 0; idx < 10; ++idx) {
      const depositEvent = generateDeposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;

      expect(deposit.depositId).to.equal(depositEvent.args.depositId);

      const slowFillRequest = slowFillRequestFromDeposit(deposit);
      requests.push(destinationSpokePoolClient.requestSlowFill(slowFillRequest));
    }
    await destinationSpokePoolClient.update(slowFillRequestedEvents);

    // Should receive _all_ slow fills submitted on the destination chain.
    const slowFillRequests = destinationSpokePoolClient.getSlowFillRequests();
    expect(slowFillRequests.length).to.equal(requests.length);

    requests.forEach(({ args }) => {
      const { originChainId, destinationChainId } = args;
      const relayData = {
        depositId: args.depositId,
        originChainId: args.originChainId,
        depositor: toAddressType(args.depositor, originChainId),
        recipient: toAddressType(args.recipient, destinationChainId),
        inputToken: toAddressType(args.inputToken, originChainId),
        inputAmount: args.inputAmount,
        outputToken: toAddressType(args.outputToken, destinationChainId),
        outputAmount: args.outputAmount,
        fillDeadline: args.fillDeadline,
        exclusiveRelayer: toAddressType(args.exclusiveRelayer, destinationChainId),
        exclusivityDeadline: args.exclusivityDeadline,
      };

      let slowFillRequest = destinationSpokePoolClient.getSlowFillRequest({
        ...relayData,
        messageHash: args.messageHash,
      });
      expect(slowFillRequest).to.exist;
      slowFillRequest = slowFillRequest!;

      // The SpokePoolClient appends destinationChainId, so check for it specifically.
      expect(slowFillRequest.destinationChainId).to.exist;
      expect(slowFillRequest.destinationChainId).to.equal(destinationChainId);
      Object.entries(relayData).forEach(
        ([k, v]) => expect(isDefined(v)).to.equal(true) && expect(slowFillRequest[k]).to.deep.equal(v)
      );
    });
  });

  it("Correctly retrieves FilledRelay events", async function () {
    // Inject a series of DepositWithBlock events.
    const fillEvents: Log[] = [];
    const relayer = toAddressType(randomAddress(), destinationChainId);

    for (let idx = 0; idx < 10; ++idx) {
      const depositEvent = generateDeposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;
      expect(deposit.depositId).to.equal(depositEvent.args.depositId);

      const fill = fillFromDeposit(deposit, relayer);
      fillEvents.push(destinationSpokePoolClient.fillRelay(fill));
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
      expect(fillEvent.outputToken.toBytes32()).to.equal(expectedFill.args.outputToken);
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

      expect(tokensBridged.l2TokenAddress).to.deep.equal(toAddressType(l2TokenAddress, i));
    }
  });

  it("Correctly truncates events with bytes32 address fields: FundsDeposited", async function () {
    for (let _i = 0; _i < 10; ++_i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer] = Array(5)
        .fill(0)
        .map((_) => EvmAddress.from(ethers.utils.hexZeroPad(randomAddress(), 32)));

      originSpokePoolClient.deposit({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
      } as DepositWithBlock);
      await originSpokePoolClient.update(fundsDepositedEvents);
      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;

      expect(deposit.depositor.eq(depositor)).to.be.true;
      expect(deposit.recipient.eq(recipient)).to.be.true;
      expect(deposit.inputToken.eq(inputToken)).to.be.true;
      expect(deposit.outputToken.eq(outputToken)).to.be.true;
      expect(deposit.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;
    }
  });
  it("Correctly truncates events with bytes32 address fields: RequestedSpeedUpDeposit", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, updatedRecipient] = Array(2)
        .fill(0)
        .map(() => EvmAddress.from(ethers.utils.hexZeroPad(randomAddress(), 32)));

      originSpokePoolClient.speedUpDeposit({ depositor, updatedRecipient, depositId: toBN(i) } as SpeedUp);
      await originSpokePoolClient.update(speedUpEvents);
      let speedUp = originSpokePoolClient.getSpeedUps()[depositor.toNative()][toBN(i).toString()].at(-1);
      expect(speedUp).to.exist;
      speedUp = speedUp!;

      expect(speedUp.depositor.eq(depositor)).to.be.true;
      expect(speedUp.updatedRecipient.eq(updatedRecipient)).to.be.true;
    }
  });
  it("Correctly truncates events with bytes32 address fields: FilledRelay", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer, relayer] = Array(6)
        .fill(0)
        .map(() => toAddressType(ethers.utils.hexZeroPad(randomAddress(), 32), originSpokePoolClient.chainId));

      originSpokePoolClient.fillRelay({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        relayer,
        depositId: toBN(i),
      } as Omit<FillWithBlock, "messageHash">);
      await originSpokePoolClient.update(filledRelayEvents);

      let relay = originSpokePoolClient.getFills().at(-1);
      expect(relay).to.exist;
      relay = relay!;

      expect(relay.depositor.eq(depositor)).to.be.true;
      expect(relay.recipient.eq(recipient)).to.be.true;
      expect(relay.inputToken.eq(inputToken)).to.be.true;
      expect(relay.outputToken.eq(outputToken)).to.be.true;
      expect(relay.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;
      expect(relay.relayer.eq(relayer)).to.be.true;
    }
  });
  it("Correctly truncates events with bytes32 address fields: RequestedSlowFill", async function () {
    for (let i = 0; i < 10; ++i) {
      const [depositor, recipient, inputToken, outputToken, exclusiveRelayer] = Array(5)
        .fill(0)
        .map(() => toAddressType(ethers.utils.hexZeroPad(randomAddress(), 32), originSpokePoolClient.chainId));

      originSpokePoolClient.requestSlowFill({
        depositor,
        recipient,
        inputToken,
        outputToken,
        exclusiveRelayer,
        depositId: toBN(i),
        originChainId: 1,
        inputAmount: toBN(i),
        outputAmount: toBN(i),
        messageHash: ZERO_BYTES,
        fillDeadline: 0,
        exclusivityDeadline: 0,
      });
      await originSpokePoolClient.update(slowFillRequestedEvents);

      let slowFill = originSpokePoolClient.getSlowFillRequestsForOriginChain(1).at(-1);
      expect(slowFill).to.exist;
      slowFill = slowFill!;

      expect(slowFill.depositor.eq(depositor)).to.be.true;
      expect(slowFill.recipient.eq(recipient)).to.be.true;
      expect(slowFill.inputToken.eq(inputToken)).to.be.true;
      expect(slowFill.outputToken.eq(outputToken)).to.be.true;
      expect(slowFill.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;
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
      ] = Array(8)
        .fill(0)
        .map((_) => toAddressType(randomAddress(), originChainId));

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
        updatedMessageHash: randomBytes(32),
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

      // RequestSlowFill
      destinationSpokePoolClient.requestSlowFill({ ...common, messageHash: randomBytes(32) });

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

      let speedUp = originSpokePoolClient.getSpeedUps()[depositor.toNative()]?.[common.depositId.toString()]?.at(-1);
      expect(speedUp).to.exist;
      speedUp = speedUp!;

      let relay = originSpokePoolClient.getFills().at(-1);
      expect(relay).to.exist;
      relay = relay!;

      let deposit = originSpokePoolClient.getDeposits().at(-1);
      expect(deposit).to.exist;
      deposit = deposit!;

      // SlowFill
      expect(slowFill.depositor.eq(depositor)).to.be.true;
      expect(slowFill.recipient.eq(recipient)).to.be.true;
      expect(slowFill.inputToken.eq(inputToken)).to.be.true;
      expect(slowFill.outputToken.eq(outputToken)).to.be.true;
      expect(slowFill.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;

      // Relay
      expect(relay.depositor.eq(depositor)).to.be.true;
      expect(relay.recipient.eq(recipient)).to.be.true;
      expect(relay.inputToken.eq(inputToken)).to.be.true;
      expect(relay.outputToken.eq(outputToken)).to.be.true;
      expect(relay.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;
      expect(relay.relayer.eq(relayer)).to.be.true;

      // SpeedUp
      expect(speedUp.depositor.eq(depositor)).to.be.true;
      expect(speedUp.updatedRecipient.eq(updatedRecipient)).to.be.true;

      // Deposit
      expect(deposit.depositor.eq(depositor)).to.be.true;
      expect(deposit.recipient.eq(recipient)).to.be.true;
      expect(deposit.inputToken.eq(inputToken)).to.be.true;
      expect(deposit.outputToken.eq(outputToken)).to.be.true;
      expect(deposit.exclusiveRelayer.eq(exclusiveRelayer)).to.be.true;

      // TokensBridged
      expect(tokensBridged.l2TokenAddress.eq(l2TokenAddress)).to.be.true;
    }
  });

  it("Correctly appends FundsDeposited messageHash", async function () {
    const _deposit = generateDeposit(originSpokePoolClient);
    expect(_deposit?.args?.messageHash).to.equal(undefined);
    await originSpokePoolClient.update(fundsDepositedEvents);

    let deposit = originSpokePoolClient.getDeposit(_deposit.args.depositId);
    expect(deposit).to.exist;
    deposit = deposit!;

    // Both event types should include messageHash.
    expect(deposit.messageHash).to.equal(getMessageHash(deposit.message));
  });
});
