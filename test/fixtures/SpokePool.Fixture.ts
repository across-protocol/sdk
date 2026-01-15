import hre from "hardhat";
import { Contract } from "ethers";
import { getContractFactory } from "../utils/getContractFactory";
import { destinationChainId, TokenRolesEnum, zeroAddress } from "../constants";

export { zeroAddress };

/**
 * Deploys a SpokePool with associated tokens for testing.
 * This is a local implementation that uses our local getContractFactory
 * instead of the one from @across-protocol/contracts.
 */
export async function deploySpokePool(
  ethers: typeof hre.ethers,
  spokePoolName = "MockSpokePool"
): Promise<{
  weth: Contract;
  erc20: Contract;
  spokePool: Contract;
  unwhitelistedErc20: Contract;
  destErc20: Contract;
  erc1271: Contract;
}> {
  const [deployerWallet, crossChainAdmin, hubPool] = await ethers.getSigners();

  // Create tokens
  const weth = await (await getContractFactory("WETH9", deployerWallet)).deploy();
  const erc20 = await (await getContractFactory("ExpandedERC20", deployerWallet)).deploy("USD Coin", "USDC", 18);
  await erc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);

  const unwhitelistedErc20 = await (
    await getContractFactory("ExpandedERC20", deployerWallet)
  ).deploy("Unwhitelisted", "UNWHITELISTED", 18);
  await unwhitelistedErc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);

  const destErc20 = await (
    await getContractFactory("ExpandedERC20WithBlacklist", deployerWallet)
  ).deploy("L2 USD Coin", "L2 USDC", 18);
  await destErc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);

  // Deploy the pool using hardhat upgrades
  const spokePool = await hre.upgrades.deployProxy(
    await getContractFactory(spokePoolName, deployerWallet),
    [0, crossChainAdmin.address, hubPool.address],
    { kind: "uups", unsafeAllow: ["delegatecall"], constructorArgs: [weth.address] }
  );
  await spokePool.setChainId(destinationChainId);

  // ERC1271
  const erc1271 = await (await getContractFactory("MockERC1271", deployerWallet)).deploy(deployerWallet.address);

  return {
    weth,
    erc20,
    spokePool,
    unwhitelistedErc20,
    destErc20,
    erc1271,
  };
}

/**
 * Creates a spoke pool fixture using hardhat-deploy's createFixture.
 */
export const spokePoolFixture = hre.deployments.createFixture(async ({ ethers }) => {
  return await deploySpokePool(ethers);
});
