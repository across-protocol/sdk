import {
  CONFIG_STORE_VERSION,
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
  destinationChainId,
  ethers,
  expect,
  getContractFactory,
  originChainId,
  zeroAddress,
} from "./utils";

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

  it("Gets L2 token counterpart", async function () {
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find L2 token mapping/
    );
    const e1 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find L2 token mapping/
    );
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e1.blockNumber)).to.equal(
      randomDestinationToken
    );

    // Now try changing the destination token. Client should correctly handle this.
    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    hubPoolClient.addEvent(e2);
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
      /Could not find L1 token mapping/
    );
    const e1 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find L1 token mapping/
    );
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // Now try changing the L1 token while keeping destination chain and L2 token the same.
    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomOriginToken, randomDestinationToken);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();

    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e2.blockNumber)
    ).to.equal(randomOriginToken);
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // If L2 token mapping doesn't exist, throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomL1Token, destinationChainId, e2.blockNumber)).to.throw(
      /Could not find L1 token mapping/
    );
    expect(() =>
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, originChainId, e2.blockNumber)
    ).to.throw(/Could not find L1 token mapping/);
  });
  it("Gets L1 token for deposit", async function () {
    const depositData = {
      originChainId,
      originToken: randomOriginToken,
    };

    const e0 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    hubPoolClient.addEvent(e0);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e0.blockNumber })).to.equal(
      randomL1Token
    );

    // quote block too early
    expect(() => hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: 0 })).to.throw(
      /Could not find L1 token mapping/
    );

    // no deposit with matching origin token
    expect(() =>
      hubPoolClient.getL1TokenForDeposit({
        ...depositData,
        originToken: randomL1Token,
        quoteBlockNumber: e0.blockNumber,
      })
    ).to.throw(/Could not find L1 token mapping/);

    const e1 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomOriginToken, randomOriginToken);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e1.blockNumber })).to.equal(
      randomOriginToken
    );
  });
  it("Gets L2 token for deposit", async function () {
    const depositData = {
      originChainId,
      originToken: randomOriginToken,
    };

    const e0 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    const e1 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    hubPoolClient.addEvent(e0);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL2TokenForDeposit(destinationChainId, { ...depositData, quoteBlockNumber: e1.blockNumber })
    ).to.equal(randomDestinationToken);

    // origin chain token is set but none for destination chain yet, as of e0.
    expect(() =>
      hubPoolClient.getL2TokenForDeposit(destinationChainId, { ...depositData, quoteBlockNumber: e0.blockNumber })
    ).to.throw(/Could not find L2 token mapping/);

    // quote block too early
    expect(() =>
      hubPoolClient.getL2TokenForDeposit(destinationChainId, { ...depositData, quoteBlockNumber: 0 })
    ).to.throw(/Could not find L1 token mapping/);

    // No deposit with matching token.
    expect(() =>
      hubPoolClient.getL2TokenForDeposit(destinationChainId, {
        ...depositData,
        originToken: randomL1Token,
        quoteBlockNumber: e0.blockNumber,
      })
    ).to.throw(/Could not find L1 token mapping/);

    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomL1Token);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL2TokenForDeposit(destinationChainId, { ...depositData, quoteBlockNumber: e2.blockNumber })
    ).to.equal(randomL1Token);
  });
});
