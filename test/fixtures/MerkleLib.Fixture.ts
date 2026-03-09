import hre from "hardhat";
import { Contract } from "ethers";
import { getContractFactory } from "../utils/getContractFactory";

export const merkleLibFixture = hre.deployments.createFixture(async (): Promise<{ merkleLibTest: Contract }> => {
  const [signer] = await hre.ethers.getSigners();
  const merkleLibTest = await (await getContractFactory("MerkleLibTest", signer)).deploy();
  return { merkleLibTest };
});
