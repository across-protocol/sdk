import "@nomiclabs/hardhat-ethers";
import fs from "fs";
import path from "path";
import { ethers } from "hardhat";
import { ContractFactory, Signer, ContractInterface } from "ethers";
import type { FactoryOptions } from "@nomiclabs/hardhat-ethers/types";
import { getAbi, getBytecode } from "@uma/contracts-node";

function isFactoryOptions(signerOrFactoryOptions: Signer | FactoryOptions): signerOrFactoryOptions is FactoryOptions {
  return (
    typeof signerOrFactoryOptions === "object" &&
    ("signer" in signerOrFactoryOptions || "libraries" in signerOrFactoryOptions)
  );
}

/**
 * Attempts to find an artifact in the @across-protocol/contracts package.
 * Uses the dist/abi/ folder which contains {abi, bytecode} per contract.
 */
function getAcrossContractsArtifact(contractName: string): { abi: unknown[]; bytecode: string } {
  const contractsPackagePath = path.dirname(require.resolve("@across-protocol/contracts/package.json"));
  const abiDir = path.join(contractsPackagePath, "dist", "abi");
  // Look in ContractName.sol/ContractName.json (Foundry convention).
  const artifactPath = path.join(abiDir, `${contractName}.sol`, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  return { abi: artifact.abi, bytecode: artifact.bytecode ?? "0x" };
}

/**
 * Local implementation of getContractFactory that searches for artifacts in multiple locations:
 * 1. Local hardhat artifacts (for contracts in this repo)
 * 2. @across-protocol/contracts dist/abi/ artifacts
 * 3. UMA contracts-node package
 */
export async function getContractFactory(
  name: string,
  signerOrFactoryOptions: Signer | FactoryOptions
): Promise<ContractFactory> {
  const signer = isFactoryOptions(signerOrFactoryOptions) ? signerOrFactoryOptions.signer : signerOrFactoryOptions;

  // 1. First, try to get the artifact from local hardhat artifacts
  try {
    return await ethers.getContractFactory(name, signerOrFactoryOptions);
  } catch {
    // Continue to other sources
  }

  // 2. Try @across-protocol/contracts dist/abi/
  try {
    const artifact = getAcrossContractsArtifact(name);
    return new ContractFactory(artifact.abi as ContractInterface, artifact.bytecode, signer);
  } catch {
    // Continue to other sources
  }

  // 3. Try UMA contracts-node package
  try {
    if (isFactoryOptions(signerOrFactoryOptions)) {
      throw new Error("Cannot pass FactoryOptions to a contract imported from UMA");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ContractFactory(getAbi(name as any), getBytecode(name as any), signerOrFactoryOptions);
  } catch {
    // Continue
  }

  throw new Error(`Could not find the artifact for ${name}!`);
}
