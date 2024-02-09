import assert from "assert";
import { Event } from "ethers";
import { random } from "lodash";
import { utils as sdkUtils } from "../src";
import { expect } from "chai";
import { DEFAULT_CONFIG_STORE_VERSION } from "../src/clients";
import { MockHubPoolClient, MockSpokePoolClient, MockConfigStoreClient } from "../src/clients/mocks";
import {
  SlowFillRequest,
  SlowFillRequestWithBlock,
  V2DepositWithBlock,
  V2FillWithBlock,
  V2RelayerRefundExecution,
  V2RelayerRefundExecutionWithBlock,
  V3DepositWithBlock,
  V3FillWithBlock,
  V3RelayData,
  V3RelayerRefundExecution,
  V3RelayerRefundExecutionWithBlock,
} from "../src/interfaces";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import {
  getCurrentTime,
  getDepositInputToken,
  getFillOutputToken,
  isDefined,
  isV2Deposit,
  isV2Fill,
  isV3Deposit,
  isV3Fill,
  isV3RelayerRefundExecution,
  randomAddress,
} from "../src/utils";
import {
  BigNumber,
  createSpyLogger,
  fillFromDeposit,
  deployConfigStore,
  hubPoolFixture,
  deploySpokePool,
  ethers,
  contractsV2Utils,
  toBNWei,
} from "./utils";
import { modifyRelayHelper } from "./constants";

type EventSearchConfig = sdkUtils.EventSearchConfig;

describe("SpokePoolClient: Event Filtering", function () {
  const fundsDepositedEvents = ["FundsDeposited", "V3FundsDeposited"];
  const requestedSpeedUpEvents = ["RequestedSpeedUpDeposit", "RequestedSpeedUpV3Deposit"];
  const slowFillRequestedEvents = ["RequestedV3SlowFill"];
  const filledRelayEvents = ["FilledRelay", "FilledV3Relay"];
  const executedRelayerRefundEvents = ["ExecutedRelayerRefundRoot", "ExecutedV3RelayerRefundRoot"];

  let owner: contractsV2Utils.SignerWithAddress, depositor: contractsV2Utils.SignerWithAddress;
  let chainIds: number[];
  let originChainId: number, destinationChainId: number, repaymentChainId: number;
  let hubPoolClient: MockHubPoolClient;
  let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
  let originSpokePoolClient: MockSpokePoolClient;
  let destinationSpokePoolClient: MockSpokePoolClient;

  const logger = createSpyLogger().spyLogger;

  const generateV2Deposit = (spokePoolClient: MockSpokePoolClient): Event => {
    const originToken = randomAddress();
    const message = EMPTY_MESSAGE;
    const quoteTimestamp = getCurrentTime() - 10;
    return spokePoolClient.deposit({ destinationChainId, originToken, message, quoteTimestamp } as V2DepositWithBlock);
  };

  const generateV3Deposit = (spokePoolClient: MockSpokePoolClient): Event => {
    const inputToken = randomAddress();
    const message = EMPTY_MESSAGE;
    const quoteTimestamp = getCurrentTime() - 10;
    return spokePoolClient.depositV3({ destinationChainId, inputToken, message, quoteTimestamp } as V3DepositWithBlock);
  };

  beforeEach(async function () {
    [owner, depositor] = await ethers.getSigners();

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
    const configStoreClient = new MockConfigStoreClient(
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
      const { spokePool } = await deploySpokePool(ethers, "_MockSpokePool");
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

  it("Correctly retrieves FundsDepositedV3 events", async function () {
    // Inject a series of V2DepositWithBlock and V3DepositWithBlock events.
    const depositEvents: Event[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      depositEvents.push(generateV2Deposit(originSpokePoolClient));
      depositEvents.push(generateV3Deposit(originSpokePoolClient));
    }
    await originSpokePoolClient.update(fundsDepositedEvents);

    // Should receive _all_ deposits submitted on originChainId.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(depositEvents.length);
    expect(deposits.filter(isV2Deposit).length).to.equal(depositEvents.length / 2);
    expect(deposits.filter(isV3Deposit).length).to.equal(depositEvents.length / 2);

    deposits.forEach((depositEvent, idx) => {
      const expectedDeposit = depositEvents[idx];

      expect(depositEvent.blockNumber).to.equal(expectedDeposit.blockNumber);

      const expectedInputToken = isV2Deposit(depositEvent)
        ? expectedDeposit.args!.originToken
        : expectedDeposit.args!.inputToken;
      const inputToken = getDepositInputToken(depositEvent);
      expect(inputToken).to.equal(expectedInputToken);
    });
  });

  it("Correctly retrieves SpeedUp events", async function () {
    // Inject a series of V2SpeedUp and V3SpeedUp events.
    const speedUpEvents: Event[] = [];
    const updateEvents = [...fundsDepositedEvents, ...requestedSpeedUpEvents];

    for (let idx = 0; idx < 10; ++idx) {
      const v2DepositEvent = generateV2Deposit(originSpokePoolClient);
      const v3DepositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(updateEvents);
      const deposits = originSpokePoolClient.getDeposits();

      let v2Deposit = deposits.filter(isV2Deposit).at(-1);
      expect(v2Deposit).to.not.be.undefined;
      v2Deposit = v2Deposit!;
      expect(v2Deposit.depositId).to.equal(v2DepositEvent.args!.depositId);

      let v3Deposit = deposits.filter(isV3Deposit).at(-1);
      expect(v3Deposit).to.not.be.undefined;
      v3Deposit = v3Deposit as V3DepositWithBlock;
      expect(v3Deposit.depositId).to.equal(v3DepositEvent.args!.depositId);

      // The deposit objects should not have new* fields populated.
      [v2Deposit, v3Deposit].forEach((deposit) => {
        expect(deposit.recipient).to.not.be.undefined;
        expect(deposit.updatedRecipient).to.be.undefined;
        expect(deposit.updatedMessage).to.be.undefined;
      });
      expect((v2Deposit as V2DepositWithBlock).newRelayerFeePct).to.be.undefined;
      expect(v3Deposit.updatedOutputAmount).to.be.undefined;

      const newRelayerFeePct = v2Deposit.relayerFeePct!.add(1);
      const { signature: v2SpeedUpSignature } = await modifyRelayHelper(
        newRelayerFeePct,
        v2Deposit.depositId.toString(),
        v2Deposit.originChainId.toString(),
        depositor,
        v2Deposit.recipient,
        v2Deposit.message
      );

      // Note: getUpdatedV3DepositSignature() is not yet available, so just fudge the event. This is
      // possible because the event is injected. The SpokePool contract would normally handle verification.
      const updatedOutputAmount = v3Deposit.outputAmount!.sub(1);
      const { signature: v3SpeedUpSignature } = await modifyRelayHelper(
        updatedOutputAmount,
        v3Deposit.depositId.toString(),
        v3Deposit.originChainId.toString(),
        depositor,
        v3Deposit.recipient,
        v3Deposit.message
      );

      speedUpEvents.push(
        originSpokePoolClient.speedUpDeposit({
          depositId: v2Deposit.depositId,
          originChainId: v2Deposit.originChainId,
          depositor: v2Deposit.depositor,
          newRelayerFeePct,
          updatedRecipient: v2Deposit.recipient,
          updatedMessage: v2Deposit.message,
          depositorSignature: v2SpeedUpSignature,
        })
      );

      speedUpEvents.push(
        originSpokePoolClient.speedUpV3Deposit({
          depositId: v3Deposit.depositId,
          originChainId: v3Deposit.originChainId,
          depositor: v3Deposit.depositor,
          updatedRecipient: v3Deposit.recipient,
          updatedOutputAmount,
          updatedMessage: v3Deposit.message,
          depositorSignature: v3SpeedUpSignature,
        })
      );
    }
    await originSpokePoolClient.update(updateEvents);

    // Should receive _all_ deposits submitted on the origin chain.
    const deposits = originSpokePoolClient.getDeposits();
    expect(deposits.length).to.equal(speedUpEvents.length);
    expect(deposits.filter(isV2Deposit).length).to.equal(speedUpEvents.length / 2);
    expect(deposits.filter(isV3Deposit).length).to.equal(speedUpEvents.length / 2);

    // Verify that each update was appended correctly.
    deposits.forEach((deposit, idx) => {
      const expectedSpeedUp = speedUpEvents[idx];

      expect(deposit.depositId).to.equal(expectedSpeedUp.args!.depositId);
      expect(deposit.depositor).to.equal(expectedSpeedUp.args!.depositor);
      expect(deposit.updatedRecipient).to.equal(expectedSpeedUp.args!.updatedRecipient);
      expect(deposit.updatedMessage).to.equal(expectedSpeedUp.args!.updatedMessage);
      if (isV2Deposit(deposit)) {
        expect(deposit.newRelayerFeePct).to.equal(expectedSpeedUp.args!.newRelayerFeePct);
      } else {
        expect(deposit.updatedOutputAmount).to.not.be.undefined;
        expect(deposit.updatedOutputAmount!.eq(expectedSpeedUp.args!.updatedOutputAmount)).to.be.true;
      }
    });
  });

  it("Correctly retrieves SlowFillRequested events", async function () {
    // Inject a series of v2DepositWithBlock and v3DepositWithBlock events.
    const requests: Event[] = [];

    const slowFillRequestFromDeposit = (deposit: V3DepositWithBlock): SlowFillRequest => {
      const { realizedLpFeePct, blockNumber, ...partialDeposit } = deposit;
      return { ...partialDeposit };
    };

    for (let idx = 0; idx < 10; ++idx) {
      const depositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      const deposits = originSpokePoolClient.getDeposits();

      let deposit = deposits.filter(isV3Deposit).at(-1);
      expect(deposit).to.not.be.undefined;
      deposit = deposit!;
      expect(deposit.depositId).to.equal(depositEvent.args!.depositId);
      assert(isV3Deposit(deposit));

      const slowFillRequest = slowFillRequestFromDeposit(deposit);
      requests.push(destinationSpokePoolClient.requestV3SlowFill(slowFillRequest as SlowFillRequestWithBlock));
    }
    await destinationSpokePoolClient.update(slowFillRequestedEvents);

    // Should receive _all_ fills submitted on the destination chain.
    requests.forEach((event) => {
      let { args } = event;
      expect(args).to.not.be.undefined;
      args = args!;

      const relayData: V3RelayData = {
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
      const v2DepositEvent = generateV2Deposit(originSpokePoolClient);
      const v3DepositEvent = generateV3Deposit(originSpokePoolClient);

      await originSpokePoolClient.update(fundsDepositedEvents);
      const deposits = originSpokePoolClient.getDeposits();

      let v2Deposit = deposits.filter(isV2Deposit).at(-1);
      expect(v2Deposit).to.not.be.undefined;
      v2Deposit = v2Deposit!;
      expect(v2Deposit.depositId).to.equal(v2DepositEvent.args!.depositId);

      let v3Deposit = deposits.filter(isV3Deposit).at(-1);
      expect(v3Deposit).to.not.be.undefined;
      v3Deposit = v3Deposit!;
      expect(v3Deposit.depositId).to.equal(v3DepositEvent.args!.depositId);

      const [v2Fill, v3Fill] = [fillFromDeposit(v2Deposit, relayer), fillFromDeposit(v3Deposit, relayer)];
      fillEvents.push(destinationSpokePoolClient.fillRelay(v2Fill as V2FillWithBlock));
      fillEvents.push(destinationSpokePoolClient.fillV3Relay(v3Fill as V3FillWithBlock));
    }
    await destinationSpokePoolClient.update(filledRelayEvents);

    // Should receive _all_ fills submitted on the destination chain.
    const fills = destinationSpokePoolClient.getFills();
    expect(fills.length).to.equal(fillEvents.length);
    expect(fills.filter(isV2Fill).length).to.equal(fillEvents.length / 2);
    expect(fills.filter(isV3Fill).length).to.equal(fillEvents.length / 2);

    fills.forEach((fillEvent, idx) => {
      const expectedFill = fillEvents[idx];

      expect(fillEvent.blockNumber).to.equal(expectedFill.blockNumber);

      // destinationChainId is appended by the SpokePoolClient for V3FundsDeposited events, so verify its correctness.
      expect(fillEvent.destinationChainId).to.equal(destinationChainId);

      const expectedOutputToken = isV2Fill(fillEvent)
        ? expectedFill.args!.destinationToken
        : expectedFill.args!.inputToken;
      const outputToken = getFillOutputToken(fillEvent);
      expect(outputToken).to.equal(expectedOutputToken);
    });
  });

  it("Correctly retrieves ExecutedV3RelayerRefundRoot events", async function () {
    const randomNumber = (max = 1_000_000): number => Math.round(Math.random() * max);
    const randomAmount = (max = 1_000_000): BigNumber => toBNWei(randomNumber(max).toPrecision(6));

    const _generateRelayerRefund = (
      chainId: number,
      rootBundleId: number,
      leafId: number,
      nRefunds: number
    ): V2RelayerRefundExecution => {
      const refundAmounts: BigNumber[] = [];
      const refundAddresses: string[] = [];
      for (let i = 0; i < nRefunds; ++i) {
        refundAmounts.push(randomAmount());
        refundAddresses.push(randomAddress());
      }

      return {
        chainId,
        rootBundleId,
        leafId,
        amountToReturn: randomAmount(),
        l2TokenAddress: randomAddress(),
        refundAmounts,
        refundAddresses,
      };
    };

    const generateV2RelayerRefund = (
      spokePoolClient: MockSpokePoolClient,
      rootBundleId: number,
      leafId: number,
      nRefunds: number
    ): Event => {
      const refund = _generateRelayerRefund(spokePoolClient.chainId, rootBundleId, leafId, nRefunds);
      return spokePoolClient.executeRelayerRefundLeaf(refund as V2RelayerRefundExecutionWithBlock);
    };

    const generateV3RelayerRefund = (
      spokePoolClient: MockSpokePoolClient,
      rootBundleId: number,
      leafId: number,
      nRefunds: number
    ): Event => {
      const refund: V3RelayerRefundExecution = {
        ..._generateRelayerRefund(spokePoolClient.chainId, rootBundleId, leafId, nRefunds),
        // The following fields are not representative of onchain events, but should be unique for test.
        fillsRefundedRoot: randomAmount().toString(),
        fillsRefundedHash: randomAmount().toString(),
      };
      return spokePoolClient.executeV3RelayerRefundLeaf(refund as V3RelayerRefundExecutionWithBlock);
    };

    const refundEvents: Event[] = [];
    const nLoops = 10;

    // Enqueue a range of refund events.
    for (let idx = 0; idx < nLoops; ++idx) {
      refundEvents.push(generateV2RelayerRefund(destinationSpokePoolClient, idx, 0, idx));
      refundEvents.push(generateV3RelayerRefund(destinationSpokePoolClient, idx, 1, idx));
    }
    expect(refundEvents.length).to.equal(nLoops * 2);

    await destinationSpokePoolClient.update(executedRelayerRefundEvents);
    const refunds = destinationSpokePoolClient.getRelayerRefundExecutions();

    expect(refunds.length).to.equal(refundEvents.length);
    expect(refunds.filter(isV3RelayerRefundExecution).length).to.equal(refundEvents.length / 2);

    refundEvents.forEach((expectedEvent) => {
      let refund = refunds.find(
        ({ rootBundleId, leafId }) =>
          rootBundleId === expectedEvent.args?.rootBundleId && leafId === expectedEvent.args?.leafId
      );
      expect(refund).to.not.be.undefined;
      refund = refund!;

      expect(refund.blockNumber).to.equal(expectedEvent.blockNumber);
      expect(refund.transactionHash).to.equal(expectedEvent.transactionHash);

      expect(refund.rootBundleId).to.equal(expectedEvent.args!.rootBundleId);
      expect(refund.leafId).to.equal(expectedEvent.args!.leafId);
      expect(refund.l2TokenAddress).to.equal(expectedEvent.args!.l2TokenAddress);
      expect(refund.amountToReturn.eq(expectedEvent.args!.amountToReturn)).to.be.true;

      if (isV3RelayerRefundExecution(refund)) {
        expect(refund.fillsRefundedRoot).to.equal(expectedEvent.args!.fillsRefundedRoot);
        expect(refund.fillsRefundedHash).to.equal(expectedEvent.args!.fillsRefundedHash);
      }
    });
  });
});
