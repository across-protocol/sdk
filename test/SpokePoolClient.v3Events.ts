import { Event } from "ethers";
import { random } from "lodash";
import { utils as sdkUtils } from "../src";
import { expect } from "chai";
import { DEFAULT_CONFIG_STORE_VERSION } from "../src/clients";
import { MockHubPoolClient, MockSpokePoolClient, MockConfigStoreClient } from "../src/clients/mocks";
import { DepositWithBlock, FillWithBlock, SlowFillRequest, SlowFillRequestWithBlock } from "../src/interfaces";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import { getCurrentTime, isDefined, randomAddress } from "../src/utils";
import {
  createSpyLogger,
  fillFromDeposit,
  deployConfigStore,
  hubPoolFixture,
  deploySpokePool,
  ethers,
  SignerWithAddress,
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

  const logger = createSpyLogger().spyLogger;

  const generateV3Deposit = (spokePoolClient: MockSpokePoolClient): Event => {
    const inputToken = randomAddress();
    const message = EMPTY_MESSAGE;
    const quoteTimestamp = getCurrentTime() - 10;
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
      const { realizedLpFeePct, blockNumber, ...partialDeposit } = deposit;
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
