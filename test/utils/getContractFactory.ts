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
 * Recursively gets all file paths in a directory.
 */
function getAllFilesInPath(dirPath: string, arrayOfFiles: string[] = []): string[] {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFilesInPath(dirPath + "/" + file, arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, "/", file));
    }
  });
  return arrayOfFiles;
}

/**
 * Foundry artifact structure
 */
interface FoundryArtifact {
  abi: unknown[];
  bytecode: {
    object: string;
    linkReferences?: Record<string, unknown>;
    sourceMap?: string;
  };
}

/**
 * Hardhat artifact structure
 */
interface HardhatArtifact {
  abi: unknown[];
  bytecode: string;
}

type Artifact = FoundryArtifact | HardhatArtifact;

function isFoundryArtifact(artifact: Artifact): artifact is FoundryArtifact {
  return typeof artifact.bytecode === "object" && "object" in artifact.bytecode;
}

/**
 * Extracts the bytecode string from an artifact, handling both Foundry and Hardhat formats.
 */
function getBytecodeFromArtifact(artifact: Artifact): string {
  if (isFoundryArtifact(artifact)) {
    return artifact.bytecode.object;
  }
  return artifact.bytecode;
}

/**
 * Finds an artifact JSON file from a given path by contract name.
 * Supports both Hardhat (artifacts/contracts/) and Foundry (out/) artifact structures.
 */
function findArtifactFromPath(contractName: string, artifactsPath: string): { abi: unknown[]; bytecode: string } {
  const allArtifactsPaths = getAllFilesInPath(artifactsPath);
  const desiredArtifactPaths = allArtifactsPaths.filter((a) => a.endsWith(`/${contractName}.json`));
  if (desiredArtifactPaths.length !== 1) {
    throw new Error(`Couldn't find desired artifact or found too many for ${contractName}`);
  }
  const artifact: Artifact = JSON.parse(fs.readFileSync(desiredArtifactPaths[0], "utf-8"));
  return {
    abi: artifact.abi,
    bytecode: getBytecodeFromArtifact(artifact),
  };
}

/**
 * Attempts to find an artifact in the @across-protocol/contracts package.
 * Uses the Foundry 'out/' folder for artifacts.
 */
function getAcrossContractsArtifact(contractName: string): { abi: unknown[]; bytecode: string } {
  const contractsPackagePath = path.dirname(require.resolve("@across-protocol/contracts/package.json"));
  const artifactsPath = path.join(contractsPackagePath, "out");
  return findArtifactFromPath(contractName, artifactsPath);
}

/**
 * Local implementation of getContractFactory that searches for artifacts in multiple locations:
 * 1. Local hardhat artifacts (for contracts in this repo)
 * 2. @across-protocol/contracts package artifacts
 * 3. UMA contracts-node package
 */
export async function getContractFactory(
  name: string,
  signerOrFactoryOptions: Signer | FactoryOptions
): Promise<ContractFactory> {
  // Get the signer from the options if needed
  const signer = isFactoryOptions(signerOrFactoryOptions) ? signerOrFactoryOptions.signer : signerOrFactoryOptions;

  // 1. First, try to get the artifact from local hardhat artifacts
  try {
    return await ethers.getContractFactory(name, signerOrFactoryOptions);
  } catch (_) {
    // Continue to other sources
  }

  // 2. Try to get from @across-protocol/contracts package
  try {
    const artifact = getAcrossContractsArtifact(name);
    return new ContractFactory(artifact.abi as ContractInterface, artifact.bytecode, signer);
  } catch (_) {
    // Continue to other sources
  }

  // 3. Try UMA contracts-node package
  try {
    if (isFactoryOptions(signerOrFactoryOptions)) {
      throw new Error("Cannot pass FactoryOptions to a contract imported from UMA");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ContractFactory(getAbi(name as any), getBytecode(name as any), signerOrFactoryOptions);
  } catch (_) {
    // Continue
  }

  throw new Error(`Could not find the artifact for ${name}!`);
}
