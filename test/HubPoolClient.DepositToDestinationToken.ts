import { CHAIN_IDs } from "@across-protocol/constants";
import { Log } from "../src/interfaces";
import {
  CONFIG_STORE_VERSION,
  destinationChainId,
  originChainId,
  randomDestinationToken,
  randomDestinationToken2,
  randomL1Token,
  randomOriginToken,
} from "./constants";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  getContractFactory,
  zeroAddress,
} from "./utils";
import { getDeployedAddress } from "@across-protocol/contracts";
import { SvmAddress } from "../src/utils/AddressUtils";

let hubPool: Contract, lpTokenFactory: Contract, mockAdapter: Contract;
let owner: SignerWithAddress;
let hubPoolClient: MockHubPoolClient;

describe("HubPoolClient: Deposit to Destination Token", function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy minimal hubPool. Don't configure the finder, timer or weth addresses as unrelated for this test file.
    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();
    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    mockAdapter = await (await getContractFactory("Mock_Adapter", owner)).deploy();
    await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, zeroAddress);

    const logger = createSpyLogger().spyLogger;
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(logger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
  });

  it("expands cross chain contracts solana addresses", async function () {
    const svmChain = CHAIN_IDs.SOLANA;
    const solanaSpokePool = getDeployedAddress("SvmSpoke", svmChain);

    expect(solanaSpokePool).to.not.be.undefined;
    if (!solanaSpokePool) {
      return;
    }

    const truncatedAddress = SvmAddress.from(solanaSpokePool).toEvmAddress();
    hubPoolClient.setCrossChainContractsEvent(svmChain, mockAdapter.address, truncatedAddress);

    await hubPoolClient.update();

    expect(hubPoolClient.getSpokePoolForBlock(svmChain).toLowerCase()).to.equal(solanaSpokePool.toLowerCase());
  });

  it("Gets L2 token counterpart", async function () {
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find SpokePool mapping/
    );
    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find SpokePool mapping/
    );
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e1.blockNumber)).to.equal(
      randomDestinationToken
    );

    // Now try changing the destination token. Client should correctly handle this.
    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    await hubPoolClient.update();

    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e2.blockNumber)).to.equal(
      randomDestinationToken2
    );
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e1.blockNumber)).to.equal(
      randomDestinationToken
    );
  });
  it("Gets L1 token counterpart", async function () {
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find HubPool mapping/
    );
    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find HubPool mapping/
    );
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // Now try changing the L1 token while keeping destination chain and L2 token the same.
    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomOriginToken, randomDestinationToken);
    await hubPoolClient.update();

    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e2.blockNumber)
    ).to.equal(randomOriginToken);
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // If L2 token mapping doesn't exist, throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomL1Token, destinationChainId, e2.blockNumber)).to.throw(
      /Could not find HubPool mapping/
    );
    expect(() =>
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, originChainId, e2.blockNumber)
    ).to.throw(/Could not find HubPool mapping/);
  });
  it("Gets L1 token for deposit", async function () {
    const depositData = {
      originChainId,
      inputToken: randomOriginToken,
    };

    const e0 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e0.blockNumber })).to.equal(
      randomL1Token
    );

    // quote block too early
    expect(() => hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: 0 })).to.throw(
      /Could not find HubPool mapping/
    );

    // no deposit with matching origin token
    expect(() =>
      hubPoolClient.getL1TokenForDeposit({
        ...depositData,
        inputToken: randomL1Token,
        quoteBlockNumber: e0.blockNumber,
      })
    ).to.throw(/Could not find HubPool mapping/);

    const e1 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomOriginToken, randomOriginToken);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e1.blockNumber })).to.equal(
      randomOriginToken
    );
  });
  it("Gets L2 token for deposit", async function () {
    const depositData = {
      originChainId,
      inputToken: randomOriginToken,
    };

    const e0 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: e1.blockNumber })
    ).to.equal(randomDestinationToken);

    // origin chain token is set but none for destination chain yet, as of e0.
    expect(() =>
      hubPoolClient.getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: e0.blockNumber })
    ).to.throw(/Could not find SpokePool mapping/);

    // quote block too early
    expect(() =>
      hubPoolClient.getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: 0 })
    ).to.throw(/Could not find HubPool mapping/);

    // No deposit with matching token.
    expect(() =>
      hubPoolClient.getL2TokenForDeposit({
        ...depositData,
        destinationChainId,
        inputToken: randomL1Token,
        quoteBlockNumber: e0.blockNumber,
      })
    ).to.throw(/Could not find HubPool mapping/);

    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomL1Token);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: e2.blockNumber })
    ).to.equal(randomL1Token);
  });

  it("Correctly implements token equivalency", async function () {
    let equivalent: boolean;
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId
    );
    expect(equivalent).to.be.false;

    const events: Log[] = [];
    [
      [originChainId.toString(), randomL1Token, randomOriginToken],
      [destinationChainId.toString(), randomL1Token, randomDestinationToken],
    ].forEach(([chainId, hubPoolToken, spokePoolToken]) => {
      const event = hubPoolClient.setPoolRebalanceRoute(
        Number(chainId),
        hubPoolToken,
        spokePoolToken,
        { blockNumber: events[0]?.blockNumber } // Force all updates to be parsed in the same block.
      );
      events.push(event);
    });

    // The HubPoolClient should not know about the new token mappings until after its next update.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId,
      Number.MAX_SAFE_INTEGER
    );
    expect(equivalent).to.be.false;

    // Update the HubPoolClient to parse the new token mappings.
    await hubPoolClient.update();

    // The block before the new routes were added should still be non-equivalent.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId,
      events[0].blockNumber - 1
    );
    expect(equivalent).to.be.false;

    // As at the update, the mappings should be known.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId,
      events[0].blockNumber
    );
    expect(equivalent).to.be.true;

    // Update the token mapping and read it into the HubPoolClient.
    const update = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    await hubPoolClient.update();

    // Mapping should still be valid until the latest update.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId,
      update.blockNumber - 1
    );
    expect(equivalent).to.be.true;

    // The original mapping is no longer valid as at the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken,
      destinationChainId,
      update.blockNumber
    );
    expect(equivalent).to.be.false;

    // The new mapping was not valid before the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken2,
      destinationChainId,
      update.blockNumber - 1
    );
    expect(equivalent).to.be.false;

    // The new mapping is valid as at the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      randomOriginToken,
      originChainId,
      randomDestinationToken2,
      destinationChainId,
      update.blockNumber
    );
    expect(equivalent).to.be.true;
  });
});
