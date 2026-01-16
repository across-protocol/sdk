// Sets up all contracts necessary to build and execute leaves in dataworker merkle roots: relayer refund, slow relay,
import "@nomiclabs/hardhat-ethers";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-deploy";
import hre from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { Contract } from "ethers";
import { getContractFactory } from "../utils/getContractFactory";
import { EthersTestLibrary } from "../types";
import {
  amountToLp,
  destinationChainId as defaultDestinationChainId,
  originChainId as defaultOriginChainId,
  repaymentChainId,
  TokenRolesEnum,
  finalFee,
  finalFeeUsdc,
  finalFeeUsdt,
  bondAmount,
  randomAddress,
} from "../constants";
import {
  deploySpokePoolWithToken,
  enableRoutesOnHubPool,
  createSpyLogger,
  winston,
  deployAndConfigureHubPool,
  deployConfigStore,
  setupTokensForWallet,
  getLastBlockTime,
  sinon,
} from "../utils";
import * as clients from "../../src/clients";
import { MockConfigStoreClient } from "../mocks";
import { setupUmaEcosystem } from "./UmaEcosystemFixture";

export async function setupHubPool(
  ethers: EthersTestLibrary,
  maxRefundPerRelayerRefundLeaf: number,
  maxL1TokensPerPoolRebalanceLeaf: number,
  destinationChainId = defaultDestinationChainId,
  originChainId = defaultOriginChainId,
  lookbackForAllChains?: number
): Promise<{
  hubPool: Contract;
  spokePool_1: Contract;
  erc20_1: Contract;
  spokePool_2: Contract;
  erc20_2: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  configStore: Contract;
  timer: Contract;
  spokePoolClient_1: clients.SpokePoolClient;
  spokePoolClient_2: clients.SpokePoolClient;
  spokePoolClient_3: clients.SpokePoolClient;
  spokePoolClient_4: clients.SpokePoolClient;
  spokePoolClients: { [chainId: number]: clients.SpokePoolClient };
  mockedConfigStoreClient: MockConfigStoreClient;
  configStoreClient: clients.AcrossConfigStoreClient;
  hubPoolClient: clients.HubPoolClient;
  spyLogger: winston.Logger;
  spy: sinon.SinonSpy;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
  dataworker: SignerWithAddress;
  updateAllClients: () => Promise<void>;
}> {
  const [owner, depositor, relayer, dataworker] = await ethers.getSigners();
  const hubPoolChainId = await owner.getChainId();

  const { spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId);
  const { spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId);
  const { spokePool: spokePool_3 } = await deploySpokePoolWithToken(repaymentChainId);
  const { spokePool: spokePool_4 } = await deploySpokePoolWithToken(hubPoolChainId);
  const spokePoolDeploymentBlocks = {
    [originChainId]: await spokePool_1.provider.getBlockNumber(),
    [destinationChainId]: await spokePool_2.provider.getBlockNumber(),
    [repaymentChainId]: await spokePool_3.provider.getBlockNumber(),
    [hubPoolChainId]: await spokePool_4.provider.getBlockNumber(),
  };
  const testChainIdList = Object.keys(spokePoolDeploymentBlocks).map((_chainId) => Number(_chainId));

  const umaEcosystem = await setupUmaEcosystem(owner);
  const { hubPool, hubPoolDeploymentBlock, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(
    owner,
    [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      // Following spoke pool destinations should not be used in tests but need to be set for dataworker to fetch
      // spoke pools for those chains in proposeRootBundle
      { l2ChainId: repaymentChainId, spokePool: spokePool_3 },
      { l2ChainId: hubPoolChainId, spokePool: spokePool_4 },
    ],
    umaEcosystem.finder.address,
    umaEcosystem.timer.address
  );

  // For each chain, enable routes to both erc20's so that we can fill relays
  await enableRoutesOnHubPool(hubPool, [
    { destinationChainId: originChainId, l1Token: l1Token_1, destinationToken: erc20_1 },
    { destinationChainId: destinationChainId, l1Token: l1Token_1, destinationToken: erc20_2 },
    { destinationChainId: originChainId, l1Token: l1Token_2, destinationToken: erc20_2 },
    { destinationChainId: destinationChainId, l1Token: l1Token_2, destinationToken: erc20_1 },
    // Need to enable L1 token route to itself on Hub Pool so that hub pool client can look up the L1 token for
    // its own chain.
    {
      destinationChainId: hubPoolChainId,
      l1Token: l1Token_1,
      destinationToken: l1Token_1,
    },
    // Similar to above, should enable route for repayment chain as well so that config store client can look up
    // token on that chain.
    { destinationChainId: repaymentChainId, l1Token: l1Token_1, destinationToken: l1Token_1 },
  ]);

  // Set bond currency on hub pool so that roots can be proposed.
  await umaEcosystem.collateralWhitelist.addToWhitelist(l1Token_1.address);
  await umaEcosystem.store.setFinalFee(l1Token_1.address, { rawValue: "0" });
  await hubPool.setBond(l1Token_1.address, "1"); // We set to 1 Wei since we can't set to 0.

  // Give dataworker final fee bond to propose roots with:
  await setupTokensForWallet(hubPool, dataworker, [l1Token_1], undefined, 100);

  const { spyLogger, spy } = createSpyLogger();

  // Set up config store.
  const { configStore } = await deployConfigStore(
    owner,
    [l1Token_1, l1Token_2],
    maxL1TokensPerPoolRebalanceLeaf,
    maxRefundPerRelayerRefundLeaf
  );

  const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
  configStoreClient.setAvailableChains(testChainIdList);

  await configStoreClient.update();

  const hubPoolClient = new clients.HubPoolClient(
    spyLogger,
    hubPool,
    configStoreClient,
    hubPoolDeploymentBlock,
    hubPoolChainId
  );

  const [spokePoolClient_1, spokePoolClient_2, spokePoolClient_3, spokePoolClient_4] =
    await _constructSpokePoolClientsWithLookback(
      [spokePool_1, spokePool_2, spokePool_3, spokePool_4],
      [originChainId, destinationChainId, repaymentChainId, hubPoolChainId],
      spyLogger,
      relayer,
      hubPoolClient,
      lookbackForAllChains,
      spokePoolDeploymentBlocks
    );

  // This client dictionary can be conveniently passed in root builder functions that expect mapping of clients to
  // load events from. Dataworker needs a client mapped to every chain ID set in testChainIdList.
  const spokePoolClients = {
    [originChainId]: spokePoolClient_1,
    [destinationChainId]: spokePoolClient_2,
    [repaymentChainId]: spokePoolClient_3,
    [hubPoolChainId]: spokePoolClient_4,
  };

  // Give owner tokens to LP on HubPool with.
  await setupTokensForWallet(spokePool_1, owner, [l1Token_1, l1Token_2], undefined, 100); // Seed owner to LP.
  await l1Token_1.approve(hubPool.address, amountToLp);
  await l1Token_2.approve(hubPool.address, amountToLp);
  await hubPool.addLiquidity(l1Token_1.address, amountToLp);
  await hubPool.addLiquidity(l1Token_2.address, amountToLp);

  // Give depositors the tokens they'll deposit into spoke pools:
  await setupTokensForWallet(spokePool_1, depositor, [erc20_1, erc20_2], undefined, 10);
  await setupTokensForWallet(spokePool_2, depositor, [erc20_2, erc20_1], undefined, 10);

  // Give relayers the tokens they'll need to relay on spoke pools:
  await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2, l1Token_1, l1Token_2], undefined, 10);
  await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2, l1Token_1, l1Token_2], undefined, 10);

  // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
  // "reasonable" block number based off the block time when looking at quote timestamps.
  await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_2.provider));

  return {
    hubPool,
    spokePool_1,
    erc20_1,
    spokePool_2,
    erc20_2,
    l1Token_1,
    l1Token_2,
    configStore,
    timer: umaEcosystem.timer,
    spokePoolClient_1,
    spokePoolClient_2,
    spokePoolClient_3,
    spokePoolClient_4,
    spokePoolClients,
    configStoreClient: configStoreClient as unknown as clients.AcrossConfigStoreClient,
    mockedConfigStoreClient: configStoreClient,
    hubPoolClient,
    spyLogger,
    spy,
    owner,
    depositor,
    relayer,
    dataworker,
    updateAllClients: async () => {
      await configStoreClient.update();
      await hubPoolClient.update();
      await spokePoolClient_1.update();
      await spokePoolClient_2.update();
      await spokePoolClient_3.update();
      await spokePoolClient_4.update();
    },
  };
}

async function _constructSpokePoolClientsWithLookback(
  spokePools: Contract[],
  spokePoolChains: number[],
  spyLogger: winston.Logger,
  signer: SignerWithAddress,
  hubPoolClient: clients.HubPoolClient,
  lookbackForAllChains?: number,
  deploymentBlocks?: { [chainId: number]: number }
) {
  await hubPoolClient.update();
  const latestBlocks = await Promise.all(spokePools.map((x) => x.provider.getBlockNumber()));
  return spokePools.map((pool, i) => {
    return new clients.EVMSpokePoolClient(
      spyLogger,
      pool.connect(signer),
      hubPoolClient,
      spokePoolChains[i],
      deploymentBlocks?.[spokePoolChains[i]] ?? 0,
      lookbackForAllChains === undefined ? undefined : { from: latestBlocks[i] - lookbackForAllChains }
    );
  });
}

/**
 * Deploys a complete HubPool environment for testing.
 * This is a local implementation that uses our local getContractFactory
 * instead of the one from @across-protocol/contracts.
 */
export async function deployHubPool(
  ethers: typeof hre.ethers,
  spokePoolName = "MockSpokePool"
): Promise<{
  timer: Contract;
  finder: Contract;
  collateralWhitelist: Contract;
  identifierWhitelist: Contract;
  store: Contract;
  optimisticOracle: Contract;
  mockOracle: Contract;
  hubPool: Contract;
  mockAdapter: Contract;
  mockSpoke: Contract;
  crossChainAdmin: SignerWithAddress;
  l2Weth: string;
  l2Dai: string;
  l2Usdc: string;
  l2Usdt: string;
  l2UsdtContract: Contract;
  weth: Contract;
  usdc: Contract;
  dai: Contract;
  usdt: Contract;
}> {
  const [signer, crossChainAdmin] = await ethers.getSigners();

  // This fixture is dependent on the UMA ecosystem fixture
  const parentFixture = await setupUmaEcosystem(signer);

  // Create 4 tokens: WETH for wrapping/unwrapping and 3 ERC20s with different decimals
  const weth = await (await getContractFactory("WETH9", signer)).deploy();
  const usdc = await (await getContractFactory("ExpandedERC20", signer)).deploy("USD Coin", "USDC", 6);
  await usdc.addMember(TokenRolesEnum.MINTER, signer.address);

  const dai = await (await getContractFactory("ExpandedERC20", signer)).deploy("DAI Stablecoin", "DAI", 18);
  await dai.addMember(TokenRolesEnum.MINTER, signer.address);

  const usdt = await (await getContractFactory("ExpandedERC20", signer)).deploy("USDT Stablecoin", "USDT", 6);
  await usdt.addMember(TokenRolesEnum.MINTER, signer.address);

  const tokens = { weth, usdc, dai, usdt };

  // Set the above currencies as approved in the UMA collateralWhitelist
  await parentFixture.collateralWhitelist.addToWhitelist(weth.address);
  await parentFixture.collateralWhitelist.addToWhitelist(usdc.address);
  await parentFixture.collateralWhitelist.addToWhitelist(dai.address);
  await parentFixture.collateralWhitelist.addToWhitelist(usdt.address);

  // Set the finalFee for all the new tokens
  await parentFixture.store.setFinalFee(weth.address, { rawValue: finalFee });
  await parentFixture.store.setFinalFee(usdc.address, { rawValue: finalFeeUsdc });
  await parentFixture.store.setFinalFee(dai.address, { rawValue: finalFee });
  await parentFixture.store.setFinalFee(usdt.address, { rawValue: finalFeeUsdt });

  // Deploy the hubPool
  const lpTokenFactory = await (await getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, parentFixture.finder.address, weth.address, parentFixture.timer.address);
  await hubPool.setBond(weth.address, bondAmount);
  await hubPool.setLiveness(7200); // refundProposalLiveness

  // Deploy a mock chain adapter and add it as the chainAdapter for the test chainId
  const mockAdapter = await (await getContractFactory("Mock_Adapter", signer)).deploy();
  const mockSpoke = await hre.upgrades.deployProxy(
    await getContractFactory(spokePoolName, signer),
    [0, crossChainAdmin.address, hubPool.address],
    { kind: "uups", unsafeAllow: ["delegatecall"], constructorArgs: [weth.address] }
  );
  await hubPool.setCrossChainContracts(repaymentChainId, mockAdapter.address, mockSpoke.address);
  await hubPool.setCrossChainContracts(defaultOriginChainId, mockAdapter.address, mockSpoke.address);

  // Deploy a new set of mocks for mainnet
  const mainnetChainId = await hre.getChainId();
  const mockAdapterMainnet = await (await getContractFactory("Mock_Adapter", signer)).deploy();
  const mockSpokeMainnet = await hre.upgrades.deployProxy(
    await getContractFactory(spokePoolName, signer),
    [0, crossChainAdmin.address, hubPool.address],
    { kind: "uups", unsafeAllow: ["delegatecall"], constructorArgs: [weth.address] }
  );
  await hubPool.setCrossChainContracts(mainnetChainId, mockAdapterMainnet.address, mockSpokeMainnet.address);

  // We need l2Usdt to be a real contract for testing OFT bridging
  const l2UsdtContract = await (await getContractFactory("ExpandedERC20", signer)).deploy("USDT Stablecoin", "USDT", 6);
  await l2UsdtContract.addMember(TokenRolesEnum.MINTER, signer.address);

  // Deploy mock l2 tokens for each token created before and whitelist the routes
  const mockTokens = {
    l2Weth: randomAddress(),
    l2Dai: randomAddress(),
    l2Usdc: randomAddress(),
    l2Usdt: l2UsdtContract.address,
  };

  // Whitelist pool rebalance routes but don't relay any messages to SpokePool
  await hubPool.setPoolRebalanceRoute(repaymentChainId, weth.address, mockTokens.l2Weth);
  await hubPool.setPoolRebalanceRoute(repaymentChainId, dai.address, mockTokens.l2Dai);
  await hubPool.setPoolRebalanceRoute(repaymentChainId, usdc.address, mockTokens.l2Usdc);
  await hubPool.setPoolRebalanceRoute(repaymentChainId, usdt.address, mockTokens.l2Usdt);

  return {
    ...tokens,
    l2UsdtContract,
    ...mockTokens,
    hubPool,
    mockAdapter,
    mockSpoke,
    crossChainAdmin,
    ...parentFixture,
  };
}

/**
 * Creates a hub pool fixture using hardhat-deploy's createFixture.
 */
export const hubPoolFixture = hre.deployments.createFixture(async ({ ethers }) => {
  return await deployHubPool(ethers);
});

/**
 * Enables tokens for liquidity provision on the hub pool.
 */
export async function enableTokensForLP(
  owner: SignerWithAddress,
  hubPool: Contract,
  _weth: Contract,
  tokens: Contract[]
): Promise<Contract[]> {
  const lpTokens: Contract[] = [];
  for (const token of tokens) {
    await hubPool.enableL1TokenForLiquidityProvision(token.address);
    const pooledTokens = await hubPool.callStatic.pooledTokens(token.address);
    lpTokens.push(await (await getContractFactory("ExpandedERC20", owner)).attach(pooledTokens.lpToken));
  }
  return lpTokens;
}
