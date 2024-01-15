import { random } from "lodash";
import { clients, utils as sdkUtils } from "../src";
import { expect } from "chai";
import { DEFAULT_CONFIG_STORE_VERSION } from "../src/clients";
import { MockHubPoolClient, MockSpokePoolClient, MockConfigStoreClient } from "../src/clients/mocks";
import { DepositWithBlock, FillWithBlock, v2DepositWithBlock, v2FillWithBlock } from "../src/interfaces";
import { ZERO_ADDRESS } from "../src/constants";
import {
  createSpyLogger,
  fillFromDeposit,
  deployConfigStore,
  hubPoolFixture,
  deploySpokePool,
  ethers,
  contractsV2Utils,
} from "./utils";
import { randomAddress } from "../src/utils";

type EventSearchConfig = sdkUtils.EventSearchConfig;

const { getValidFillCandidates } = clients;

let owner: contractsV2Utils.SignerWithAddress;
let chainIds: number[];
let originChainId: number, destinationChainId: number, repaymentChainId: number;
let hubPoolClient: MockHubPoolClient;
let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let originSpokePoolClient: MockSpokePoolClient;
let destinationSpokePoolClient: MockSpokePoolClient;
let repaymentSpokePoolClient: MockSpokePoolClient;

const logger = createSpyLogger().spyLogger;

const generateValidFlows = async (
  origin: MockSpokePoolClient,
  destination: MockSpokePoolClient,
  repayment: MockSpokePoolClient = destination
): Promise<{ deposit: DepositWithBlock; fill: FillWithBlock }> => {
  let event = origin.deposit({
    originChainId: origin.chainId,
    originToken: ZERO_ADDRESS,
    destinationChainId: destination.chainId,
    destinationToken: ZERO_ADDRESS,
    quoteTimestamp: hubPoolClient.currentTime - 10,
  } as v2DepositWithBlock);
  await origin.update();

  // Pull the DepositWithBlock event out of the origin SpokePoolClient to use as a Fill template.
  let deposit = origin.getDeposits().find(({ transactionHash }) => transactionHash === event.transactionHash);
  expect(deposit).to.not.be.undefined;
  deposit = deposit!;

  const fillTemplate = fillFromDeposit(deposit, randomAddress());
  fillTemplate.repaymentChainId = (repayment ?? destination).chainId;
  event = destination.fillRelay(fillTemplate as v2FillWithBlock);
  await destination.update();

  // Pull the FillWithBlock event out of the destination SpokePoolClient.
  let fill = destination.getFills().find(({ transactionHash }) => transactionHash === event.transactionHash);
  expect(fill).to.not.be.undefined;
  fill = fill!;

  return { deposit: deposit as DepositWithBlock, fill: fill as FillWithBlock };
};

describe("SpokePoolClient: Event Filtering", function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Sanity Check: Ensure that owner.provider is defined
    expect(owner.provider).to.not.be.undefined;
    if (owner.provider === undefined) {
      throw new Error("owner.provider is undefined");
    }

    destinationChainId = (await owner.provider.getNetwork()).chainId as number;

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
    repaymentSpokePoolClient = spokePoolClients[repaymentChainId];
  });

  it("Correctly filters SpokePool FilledRelay events", async function () {
    // Inject a series of paired DepositWithBlock and FillWithBlock events. Query the
    // fills with various filters applied and ensure the expected results are returned.
    const fillEvents: FillWithBlock[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      const { fill } = await generateValidFlows(
        originSpokePoolClient,
        destinationSpokePoolClient,
        idx === 0 ? repaymentSpokePoolClient : destinationSpokePoolClient // Add one random repaymentChainId for filtering.
      );
      fillEvents.push(fill);
    }

    // Should receive _all_ fills submitted on destinationChainId.
    let fills = await getValidFillCandidates(destinationChainId, spokePoolClients, undefined, ["realizedLpFeePct"]);
    expect(fills.length).to.equal(fillEvents.length);

    // Take the field from the last event and filter on it.
    // Should only get one event in response.
    for (const field of ["repaymentChainId", "relayer", "fromBlock"]) {
      let sampleEvent = fillEvents.slice(-1)[0];
      let filter = { [field]: sampleEvent[field] };

      if (field === "repaymentChainId") {
        // originChainId is the first event in the array.
        sampleEvent = fillEvents.find(({ repaymentChainId }) => repaymentChainId === repaymentChainId) as FillWithBlock;
        filter = { [field]: repaymentChainId };
      } else if (field === "fromBlock") {
        filter = { [field]: sampleEvent.blockNumber };
      }

      fills = await getValidFillCandidates(destinationChainId, spokePoolClients, filter, ["realizedLpFeePct"]);
      expect(fills.length).to.equal(1);

      if (field === "fromBlock") {
        expect(fills[0].blockNumber).to.equal(sampleEvent.blockNumber);
      } else {
        expect(fills[0][field]).to.equal(sampleEvent[field]);
      }
    }
  });
});
