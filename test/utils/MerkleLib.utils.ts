/**
 * Local Merkle tree utilities that use our local getContractFactory.
 * These are reimplementations of the utilities from @across-protocol/contracts
 * to avoid dependency on their getContractFactory which looks for Hardhat artifacts.
 */
import { BigNumber, Contract, ethers } from "ethers";
import { getContractFactory } from "./getContractFactory";
import { MerkleTree } from "@across-protocol/contracts/dist/utils/MerkleTree";
import { expect } from "chai";
import { amountToReturn, repaymentChainId } from "../constants";

const { keccak256, defaultAbiCoder } = ethers.utils;

/**
 * Get the parameter type for a contract function parameter.
 * Uses our local getContractFactory to load the contract ABI.
 */
export async function getParamType(
  contractName: string,
  functionName: string,
  paramName: string
): Promise<ethers.utils.ParamType | string> {
  const contractFactory = await getContractFactory(contractName, new ethers.VoidSigner(ethers.constants.AddressZero));
  const fragment = contractFactory.interface.fragments.find((fragment) => fragment.name === functionName);
  if (!fragment || fragment.type !== "function") {
    return "";
  }
  const functionFragment = fragment as ethers.utils.FunctionFragment;
  return functionFragment.inputs.find((input) => input.name === paramName) || "";
}

/**
 * Build a relayer refund Merkle tree.
 */
export async function buildRelayerRefundTree(
  relayerRefundLeaves: {
    leafId: BigNumber;
    chainId: BigNumber;
    amountToReturn: BigNumber;
    l2TokenAddress: string;
    refundAddresses: string[];
    refundAmounts: BigNumber[];
  }[]
): Promise<MerkleTree<unknown>> {
  for (let i = 0; i < relayerRefundLeaves.length; i++) {
    expect(relayerRefundLeaves[i].refundAddresses.length).to.equal(relayerRefundLeaves[i].refundAmounts.length);
  }
  const paramType = await getParamType("MerkleLibTest", "verifyRelayerRefund", "refund");
  const hashFn = (input: unknown) => keccak256(defaultAbiCoder.encode([paramType as ethers.utils.ParamType], [input]));
  return new MerkleTree(relayerRefundLeaves, hashFn) as MerkleTree<unknown>;
}

/**
 * Build relayer refund leaves.
 */
export function buildRelayerRefundLeaves(
  destinationChainIds: number[],
  amountsToReturn: BigNumber[],
  l2Tokens: string[],
  refundAddresses: string[][],
  refundAmounts: BigNumber[][]
): {
  leafId: BigNumber;
  chainId: BigNumber;
  amountToReturn: BigNumber;
  l2TokenAddress: string;
  refundAddresses: string[];
  refundAmounts: BigNumber[];
}[] {
  return Array(destinationChainIds.length)
    .fill(0)
    .map((_, i) => {
      return {
        leafId: BigNumber.from(i),
        chainId: BigNumber.from(destinationChainIds[i]),
        amountToReturn: amountsToReturn[i],
        l2TokenAddress: l2Tokens[i],
        refundAddresses: refundAddresses[i],
        refundAmounts: refundAmounts[i],
      };
    });
}

/**
 * Build a pool rebalance Merkle tree.
 */
export async function buildPoolRebalanceLeafTree(
  poolRebalanceLeaves: {
    leafId: BigNumber;
    chainId: BigNumber;
    groupIndex: BigNumber;
    bundleLpFees: BigNumber[];
    netSendAmounts: BigNumber[];
    runningBalances: BigNumber[];
    l1Tokens: string[];
  }[]
): Promise<MerkleTree<unknown>> {
  for (const leaf of poolRebalanceLeaves) {
    const { l1Tokens, bundleLpFees, netSendAmounts, runningBalances } = leaf;
    expect(l1Tokens.length).to.equal(bundleLpFees.length).to.equal(netSendAmounts.length);
    if (runningBalances.length !== l1Tokens.length) {
      expect(runningBalances.length).to.equal(2 * l1Tokens.length);
    }
  }
  const paramType = await getParamType("MerkleLibTest", "verifyPoolRebalance", "rebalance");
  const hashFn = (input: unknown) => keccak256(defaultAbiCoder.encode([paramType as ethers.utils.ParamType], [input]));
  return new MerkleTree(poolRebalanceLeaves, hashFn) as MerkleTree<unknown>;
}

/**
 * Build pool rebalance leaves.
 */
export function buildPoolRebalanceLeaves(
  destinationChainIds: number[],
  l1Tokens: string[][],
  bundleLpFees: BigNumber[][],
  netSendAmounts: BigNumber[][],
  runningBalances: BigNumber[][],
  groupIndex: number[]
): {
  leafId: BigNumber;
  chainId: BigNumber;
  groupIndex: BigNumber;
  bundleLpFees: BigNumber[];
  netSendAmounts: BigNumber[];
  runningBalances: BigNumber[];
  l1Tokens: string[];
}[] {
  return Array(destinationChainIds.length)
    .fill(0)
    .map((_, i) => {
      return {
        chainId: BigNumber.from(destinationChainIds[i]),
        groupIndex: BigNumber.from(groupIndex[i]),
        bundleLpFees: bundleLpFees[i],
        netSendAmounts: netSendAmounts[i],
        runningBalances: runningBalances[i],
        leafId: BigNumber.from(i),
        l1Tokens: l1Tokens[i],
      };
    });
}

/**
 * Build a slow relay Merkle tree.
 */
export async function buildSlowRelayTree(slowFills: unknown[]): Promise<MerkleTree<unknown>> {
  const paramType = await getParamType("MerkleLibTest", "verifySlowRelayFulfillment", "slowFill");
  const hashFn = (input: unknown) => keccak256(defaultAbiCoder.encode([paramType as ethers.utils.ParamType], [input]));
  return new MerkleTree(slowFills, hashFn);
}

/**
 * Build a V3 slow relay Merkle tree.
 */
export async function buildV3SlowRelayTree(slowFills: unknown[]): Promise<MerkleTree<unknown>> {
  const paramType = await getParamType("MerkleLibTest", "verifyV3SlowRelayFulfillment", "slowFill");
  const hashFn = (input: unknown) => keccak256(defaultAbiCoder.encode([paramType as ethers.utils.ParamType], [input]));
  return new MerkleTree(slowFills, hashFn);
}

/**
 * Construct a single-leaf relayer refund tree.
 */
export async function constructSingleRelayerRefundTree(
  l2Token: Contract | string,
  destinationChainId: number,
  amount?: BigNumber
): Promise<{
  leaves: {
    leafId: BigNumber;
    chainId: BigNumber;
    amountToReturn: BigNumber;
    l2TokenAddress: string;
    refundAddresses: string[];
    refundAmounts: BigNumber[];
  }[];
  tree: MerkleTree<unknown>;
}> {
  const amountToUse = amount !== undefined ? amount : amountToReturn;
  const l2TokenAddress = typeof l2Token === "string" ? l2Token : l2Token.address;
  const leaves = buildRelayerRefundLeaves([destinationChainId], [amountToUse], [l2TokenAddress], [[]], [[]]);
  const tree = await buildRelayerRefundTree(leaves);
  return { leaves, tree };
}

/**
 * Construct a single-chain pool rebalance tree.
 */
export async function constructSingleChainTree(
  token: string,
  scalingSize = 1,
  repaymentChain = repaymentChainId,
  decimals = 18
): Promise<{
  tokensSendToL2: BigNumber;
  realizedLpFees: BigNumber;
  leaves: {
    leafId: BigNumber;
    chainId: BigNumber;
    groupIndex: BigNumber;
    bundleLpFees: BigNumber[];
    netSendAmounts: BigNumber[];
    runningBalances: BigNumber[];
    l1Tokens: string[];
  }[];
  tree: MerkleTree<unknown>;
}> {
  const tokensSendToL2 = ethers.utils.parseUnits((100 * scalingSize).toString(), decimals);
  const realizedLpFees = ethers.utils.parseUnits((10 * scalingSize).toString(), decimals);
  const leaves = buildPoolRebalanceLeaves(
    [repaymentChain],
    [[token]],
    [[realizedLpFees]],
    [[tokensSendToL2]],
    [[tokensSendToL2]],
    [0]
  );
  const tree = await buildPoolRebalanceLeafTree(leaves);
  return { tokensSendToL2, realizedLpFees, leaves, tree };
}
