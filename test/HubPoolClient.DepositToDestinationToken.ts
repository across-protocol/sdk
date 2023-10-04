import { AcrossConfigStoreClient as ConfigStoreClient, HubPoolClient } from "../src/clients";
import {
  CONFIG_STORE_VERSION,
  randomDestinationToken,
  randomDestinationToken2,
  randomL1Token,
  randomOriginToken,
} from "./constants";
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
  toBN,
  zeroAddress,
} from "./utils";

let hubPool: Contract, lpTokenFactory: Contract, mockAdapter: Contract;
let owner: SignerWithAddress;
let hubPoolClient: HubPoolClient;

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
    const configStoreClient = new ConfigStoreClient(logger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
  });

  it("Correctly appends whitelisted routes to the client", async function () {
    await hubPool.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPool.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    await hubPoolClient.update();

    const depositData = {
      depositId: 0,
      depositor: owner.address,
      recipient: owner.address,
      originToken: randomOriginToken,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
      amount: toBN(1337),
      originChainId,
      destinationChainId,
      relayerFeePct: toBN(1337),
      quoteTimestamp: 1234,
      hubBlock: Number.MAX_SAFE_INTEGER,
    };
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, depositData.destinationChainId)).to.equal(
      randomDestinationToken
    );

    // Now try changing the destination token. Client should correctly handle this.
    await hubPool.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    await hubPoolClient.update();

    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, depositData.destinationChainId)).to.equal(
      randomDestinationToken2
    );
  });
  it("Get L1 token counterparts at block height", async function () {
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find L1 token mapping/
    );

    await hubPool.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    const currentBlock = await hubPool.provider.getBlockNumber();
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, currentBlock)
    ).to.equal(randomL1Token);
    expect(() =>
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, currentBlock - 10)
    ).to.throw(/Could not find L1 token mapping/);
  });
});
