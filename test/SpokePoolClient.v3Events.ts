import { Event } from "ethers";
import { random } from "lodash";
import { utils as sdkUtils } from "../src";
import { expect } from "chai";
import { DEFAULT_CONFIG_STORE_VERSION } from "../src/clients";
import { MockHubPoolClient, MockSpokePoolClient, MockConfigStoreClient } from "../src/clients/mocks";
import { v2DepositWithBlock, v2FillWithBlock, v3DepositWithBlock, v3FillWithBlock } from "../src/interfaces";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import {
  getCurrentTime,
  getDepositInputToken,
  getFillOutputToken,
  isV2Deposit,
  isV2Fill,
  isV3Deposit,
  isV3Fill,
  randomAddress,
} from "../src/utils";
import {
  createSpyLogger,
  fillFromDeposit,
  deployConfigStore,
  hubPoolFixture,
  deploySpokePool,
  ethers,
  contractsV2Utils,
} from "./utils";
import { modifyRelayHelper } from "./constants";

type EventSearchConfig = sdkUtils.EventSearchConfig;

describe("SpokePoolClient: Event Filtering", function () {
  const fundsDepositedEvents = ["FundsDeposited", "V3FundsDeposited"];
  const requestedSpeedUpEvents = ["RequestedSpeedUpDeposit", "RequestedSpeedUpV3Deposit"];
  const filledRelayEvents = ["FilledRelay", "FilledV3Relay"];

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
    return spokePoolClient.deposit({ originToken, message, quoteTimestamp } as v2DepositWithBlock);
  };

  const generateV3Deposit = (spokePoolClient: MockSpokePoolClient): Event => {
    const inputToken = randomAddress();
    const message = EMPTY_MESSAGE;
    const quoteTimestamp = getCurrentTime() - 10;
    return spokePoolClient.depositV3({ inputToken, message, quoteTimestamp } as v3DepositWithBlock);
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

  it("Correctly retrieves FundsDepositedV3 events", async function () {
    // Inject a series of v2DepositWithBlock and v3DepositWithBlock events.
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
    // Inject a series of v2SpeedUp and v3SpeedUp events.
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
      v3Deposit = v3Deposit! as v3DepositWithBlock;
      expect(v3Deposit.depositId).to.equal(v3DepositEvent.args!.depositId);

      // The deposit objects should not have new* fields populated.
      [v2Deposit, v3Deposit].forEach((deposit) => {
        expect(deposit.recipient).to.not.be.undefined;
        expect(deposit.updatedRecipient).to.be.undefined;
        expect(deposit.updatedMessage).to.be.undefined;
      });
      expect((v2Deposit as v2DepositWithBlock).newRelayerFeePct).to.be.undefined;
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
      fillEvents.push(destinationSpokePoolClient.fillRelay(v2Fill as v2FillWithBlock));
      fillEvents.push(destinationSpokePoolClient.fillV3Relay(v3Fill as v3FillWithBlock));
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

      const expectedOutputToken = isV2Fill(fillEvent)
        ? expectedFill.args!.destinationToken
        : expectedFill.args!.inputToken;
      const outputToken = getFillOutputToken(fillEvent);
      expect(outputToken).to.equal(expectedOutputToken);
    });
  });
});
