import hre from "hardhat";
import { Contract, Signer } from "ethers";
import { getContractFactory } from "../utils/getContractFactory";
import { setupUmaEcosystem } from "./UmaEcosystemFixture";
import {
  TokenRolesEnum,
  bondAmount,
  finalFee,
  finalFeeUsdc,
  finalFeeUsdt,
  originChainId,
  repaymentChainId,
  randomAddress,
} from "./constants";

// Re-export SignerWithAddress type
export type SignerWithAddress = Signer & { address: string };

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
  await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, mockSpoke.address);

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
  weth: Contract,
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
