import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
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
  assertPromiseError,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  getContractFactory,
  zeroAddress,
} from "./utils";
import { createRandomBytes32 } from "@across-protocol/contracts/dist/test-utils";
import { getDeployedAddress } from "@across-protocol/contracts";
import { EvmAddress, SvmAddress, toAddressType } from "../src/utils/AddressUtils";

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
    const configStoreClient = new MockConfigStoreClient(logger, configStore, { from: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
  });

  it("expands cross chain contracts solana addresses", async function () {
    const svmChain = CHAIN_IDs.SOLANA;
    let solanaSpokePool = getDeployedAddress("SvmSpoke", svmChain);

    expect(solanaSpokePool).to.exist;
    solanaSpokePool = solanaSpokePool!;

    const truncatedAddress = SvmAddress.from(solanaSpokePool).truncateToBytes20();
    hubPoolClient.setCrossChainContractsEvent(svmChain, mockAdapter.address, truncatedAddress);

    await hubPoolClient.update();

    expect(hubPoolClient.getSpokePoolForBlock(svmChain)).to.equal(SvmAddress.from(solanaSpokePool));
  });

  it("Gets L2 token counterpart", async function () {
    const randomL1TokenAddr = EvmAddress.from(randomL1Token);

    const randomDestinationTokenAddr = toAddressType(randomDestinationToken, CHAIN_IDs.MAINNET);
    const randomDestinationToken2Addr = toAddressType(randomDestinationToken2, CHAIN_IDs.MAINNET);

    let l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, 0);
    expect(l2Token).to.be.undefined;

    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, 0);
    expect(l2Token).to.be.undefined;

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e1.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationTokenAddr.toNative());

    // Now try changing the destination token. Client should correctly handle this.
    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    await hubPoolClient.update();

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e2.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationToken2Addr.toNative());

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e1.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationTokenAddr.toNative());
  });
  it("Gets L1 token counterpart", async function () {
    let l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      EvmAddress.from(randomDestinationToken),
      destinationChainId,
      0
    );
    expect(l1Token).to.be.undefined;

    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(EvmAddress.from(randomDestinationToken), destinationChainId, 0);
    expect(l1Token).to.be.undefined;

    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      EvmAddress.from(randomDestinationToken),
      destinationChainId,
      e1.blockNumber
    );
    expect(l1Token?.toNative()).to.be.equal(EvmAddress.from(randomL1Token).toNative());

    // Now try changing the L1 token while keeping destination chain and L2 token the same.
    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomOriginToken, randomDestinationToken);
    await hubPoolClient.update();

    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      toAddressType(randomDestinationToken, destinationChainId),
      destinationChainId,
      e2.blockNumber
    );
    expect(l1Token?.toNative()).to.be.equal(EvmAddress.from(randomOriginToken).toNative());

    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      toAddressType(randomDestinationToken, destinationChainId),
      destinationChainId,
      e1.blockNumber
    );
    expect(l1Token?.toNative()).to.be.equal(EvmAddress.from(randomL1Token).toNative());

    // If L2 token mapping doesn't exist, throw.
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      toAddressType(randomL1Token, destinationChainId),
      destinationChainId,
      e2.blockNumber
    );
    expect(l1Token).to.be.undefined;

    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      toAddressType(randomDestinationToken, originChainId),
      originChainId,
      e2.blockNumber
    );
    expect(l1Token).to.be.undefined;
  });
  it("Gets L1 token for deposit", async function () {
    const depositData = {
      originChainId,
      inputToken: EvmAddress.from(randomOriginToken),
    };

    const e0 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e0.blockNumber })?.toNative()
    ).to.equal(randomL1Token);

    // quote block too early
    let l1Token = hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: 0 });
    expect(l1Token).to.be.undefined;

    // no deposit with matching origin token
    l1Token = hubPoolClient.getL1TokenForDeposit({
      ...depositData,
      inputToken: EvmAddress.from(randomL1Token),
      quoteBlockNumber: e0.blockNumber,
    });
    expect(l1Token).to.be.undefined;

    const e1 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomOriginToken, randomOriginToken);
    await hubPoolClient.update();
    expect(
      hubPoolClient.getL1TokenForDeposit({ ...depositData, quoteBlockNumber: e1.blockNumber })?.toNative()
    ).to.equal(randomOriginToken);
  });
  it("Gets L2 token for deposit", async function () {
    const depositData = {
      originChainId,
      inputToken: EvmAddress.from(randomOriginToken),
    };

    const e0 = hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();
    expect(
      hubPoolClient
        .getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: e1.blockNumber })
        ?.toString()
    ).to.equal(randomDestinationToken);

    // origin chain token is set but none for destination chain yet, as of e0.
    let l2Token = hubPoolClient.getL2TokenForDeposit({
      ...depositData,
      destinationChainId,
      quoteBlockNumber: e0.blockNumber,
    });
    expect(l2Token).to.be.undefined;

    // quote block too early
    l2Token = hubPoolClient.getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: 0 });
    expect(l2Token).to.be.undefined;

    // No deposit with matching token.
    l2Token = hubPoolClient.getL2TokenForDeposit({
      ...depositData,
      destinationChainId,
      inputToken: EvmAddress.from(randomL1Token),
      quoteBlockNumber: e0.blockNumber,
    });
    expect(l2Token).to.be.undefined;

    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomL1Token);
    await hubPoolClient.update();
    expect(
      hubPoolClient
        .getL2TokenForDeposit({ ...depositData, destinationChainId, quoteBlockNumber: e2.blockNumber })
        ?.toString()
    ).to.equal(randomL1Token);
  });

  it("Correctly implements token equivalency", async function () {
    let equivalent: boolean;
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      EvmAddress.from(randomDestinationToken),
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
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      EvmAddress.from(randomDestinationToken),
      destinationChainId,
      Number.MAX_SAFE_INTEGER
    );
    expect(equivalent).to.be.false;

    // Update the HubPoolClient to parse the new token mappings.
    await hubPoolClient.update();

    // The block before the new routes were added should still be non-equivalent.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomOriginToken, originChainId),
      destinationChainId,
      events[0].blockNumber - 1
    );
    expect(equivalent).to.be.false;

    // As at the update, the mappings should be known.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomDestinationToken, destinationChainId),
      destinationChainId,
      events[0].blockNumber
    );
    expect(equivalent).to.be.true;

    // Update the token mapping and read it into the HubPoolClient.
    const update = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    await hubPoolClient.update();

    // Mapping should still be valid until the latest update.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomDestinationToken, destinationChainId),
      destinationChainId,
      update.blockNumber - 1
    );
    expect(equivalent).to.be.true;

    // The original mapping is no longer valid as at the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomDestinationToken, destinationChainId),
      destinationChainId,
      update.blockNumber
    );
    expect(equivalent).to.be.false;

    // The new mapping was not valid before the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomDestinationToken2, destinationChainId),
      destinationChainId,
      update.blockNumber - 1
    );
    expect(equivalent).to.be.false;

    // The new mapping is valid as at the update block.
    equivalent = hubPoolClient.areTokensEquivalent(
      toAddressType(randomOriginToken, originChainId),
      originChainId,
      toAddressType(randomDestinationToken2, destinationChainId),
      destinationChainId,
      update.blockNumber
    );
    expect(equivalent).to.be.true;
  });

  it("Correctly handles SVM addresses in pool rebalance routes", async function () {
    const svmChain = CHAIN_IDs.SOLANA;

    const usdcTokenSol = TOKEN_SYMBOLS_MAP.USDC.addresses[svmChain];

    // Set up initial route with truncated SVM address
    const truncatedAddress = SvmAddress.from(usdcTokenSol).truncateToBytes20();
    const e1 = hubPoolClient.setPoolRebalanceRoute(svmChain, randomL1Token, truncatedAddress);
    await hubPoolClient.update();

    // Verify that the L2 token mapping is correctly expanded to full SVM address
    expect(
      hubPoolClient.getL2TokenForL1TokenAtBlock(EvmAddress.from(randomL1Token), svmChain, e1.blockNumber)?.toBytes32()
    ).to.equal(SvmAddress.from(usdcTokenSol).toBytes32());

    // Verify that the L1 token mapping is also correct
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(SvmAddress.from(usdcTokenSol), svmChain, e1.blockNumber)?.toNative()
    ).to.equal(EvmAddress.from(randomL1Token).toNative());

    // Test changing the route with a different SVM address - this will fail
    // because only USDC is supported as an L2 on SVM
    const newSvmAddress = SvmAddress.from(createRandomBytes32()).truncateToBytes20();
    hubPoolClient.setPoolRebalanceRoute(svmChain, randomL1Token, newSvmAddress);
    await assertPromiseError(hubPoolClient.update(), "SVM USDC address mismatch for chain");
  });

  it("correctly disables a rebalancing route", async function () {
    const randomL1TokenAddr = EvmAddress.from(randomL1Token);

    const randomDestinationTokenAddr = toAddressType(randomDestinationToken, CHAIN_IDs.MAINNET);

    const e0 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    let l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e0.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationTokenAddr.toNative());
    let l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(
      randomDestinationTokenAddr,
      destinationChainId,
      e0.blockNumber
    );
    expect(l1Token?.toNative()).to.be.equal(randomL1Token);

    const e1 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, zeroAddress);
    await hubPoolClient.update();

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e0.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationTokenAddr.toNative());
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationTokenAddr, destinationChainId, e0.blockNumber);
    expect(l1Token?.toNative()).to.be.equal(randomL1Token);

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e1.blockNumber);
    expect(l2Token).to.be.undefined;
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationTokenAddr, destinationChainId, e1.blockNumber);
    expect(l1Token).to.be.undefined;

    // setting a new route should override the disabled route
    const e2 = hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    await hubPoolClient.update();

    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e2.blockNumber);
    expect(l2Token?.toNative()).to.be.equal(randomDestinationTokenAddr.toNative());
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationTokenAddr, destinationChainId, e2.blockNumber);
    expect(l1Token?.toNative()).to.be.equal(randomL1Token);

    // check make sure historical routes are still valid
    l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1TokenAddr, destinationChainId, e1.blockNumber);
    expect(l2Token).to.be.undefined;
    l1Token = hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationTokenAddr, destinationChainId, e1.blockNumber);
    expect(l1Token).to.be.undefined;
  });
});
