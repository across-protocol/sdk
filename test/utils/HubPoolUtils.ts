// Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size

import { Contract, BigNumber } from "ethers";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { MockHubPoolClient } from "../mocks/MockHubPoolClient";
import {
  SignerWithAddress,
  createRandomBytes32,
  toBN,
  AcrossConfigStore,
  getContractFactory,
  utf8ToHex,
  constants,
  seedWallet,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  getSampleRateModel,
  TokenRolesEnum,
} from "./index";
import { AcrossConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../../src/clients";
import { PROTOCOL_DEFAULT_CHAIN_ID_INDICES } from "../../src/constants";

// Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size
// can be hardcoded by providing a `randomJumpOverride` parameter.
export async function publishValidatedBundles(
  chainIds: number[],
  l1Tokens: string[],
  hubPoolClient: MockHubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  numberOfBundles: number,
  _runningBalances?: BigNumber[],
  _incentiveBalances?: BigNumber[]
): Promise<Record<number, { start: number; end: number }[]>> {
  // Create a sets of unique block ranges per chain so that we have a lower chance of false positives
  // when fetching the block ranges for a specific chain.
  const expectedBlockRanges: Record<number, { start: number; end: number }[]> = {}; // Save expected ranges here
  let nextBlockRangesForChain = Object.fromEntries(
    chainIds.map((chainId) => {
      // Random block range between 25 and 50 blocks.
      const randomJump = 25 + Math.floor(Math.random() * 25);
      const _blockRange = [chainId, { start: 0, end: randomJump }];
      return _blockRange;
    })
  );

  const runningBalances = _runningBalances ?? chainIds.map(() => toBN(0));
  const incentiveBalances = _incentiveBalances ?? chainIds.map(() => toBN(0));
  for (let i = 0; i < numberOfBundles; i++) {
    const bundleEvaluationBlockNumbers = chainIds.map((chainId) => {
      if (!expectedBlockRanges[chainId]) {
        expectedBlockRanges[chainId] = [];
      }
      return toBN(nextBlockRangesForChain[chainId].end);
    });

    hubPoolClient.proposeRootBundle(
      Date.now(), // challengePeriodEndTimestamp
      chainIds.length, // poolRebalanceLeafCount
      bundleEvaluationBlockNumbers,
      createRandomBytes32() // Random pool rebalance root we can check.
    );
    await hubPoolClient.update();
    chainIds.forEach((chainId) => {
      expectedBlockRanges[chainId].push({
        ...nextBlockRangesForChain[chainId],
      });
    });
    chainIds.forEach((chainId, leafIndex) => {
      hubPoolClient.executeRootBundle(
        toBN(0),
        leafIndex,
        toBN(chainId),
        l1Tokens, // l1Tokens
        runningBalances, // bundleLpFees
        runningBalances, // netSendAmounts
        runningBalances.concat(incentiveBalances) // runningBalances
      );
    });

    await hubPoolClient.update();

    // Make next block range span a random number of blocks:
    const nextBlockRangeSize = 25 + Math.ceil(Math.random() * 25);
    nextBlockRangesForChain = Object.fromEntries(
      chainIds.map((chainId) => [
        chainId,
        {
          start: nextBlockRangesForChain[chainId].end + 1,
          end: nextBlockRangesForChain[chainId].end + 1 + nextBlockRangeSize,
        },
      ])
    );
  }
  await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));

  // Iterate over all the expected block ranges. Our goal is to ensure that none of the
  // block ranges are invalid for the case of testing purposes. If we find a `start` block
  // that is equal to or greater than the `end` block, we will set the `end` block to be
  // equal to the `start` block + 1.
  Object.values(expectedBlockRanges).forEach((blockRanges) => {
    blockRanges.forEach((blockRange) => {
      if (blockRange.start >= blockRange.end) {
        blockRange.end = blockRange.start + 1;
      }
    });
  });

  // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
  // client was provided for the chain. In this case we assume that chain is disabled.
  chainIds.forEach((chainId) => {
    expectedBlockRanges[chainId][expectedBlockRanges[chainId].length - 1].end =
      spokePoolClients[chainId].latestBlockSearched;
  });
  return expectedBlockRanges;
}

export async function deployConfigStore(
  signer: SignerWithAddress,
  tokensToAdd: Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = getSampleRateModel(),
  additionalChainIdIndices?: number[]
): Promise<{ configStore: AcrossConfigStore; deploymentBlock: number }> {
  const configStore = (await (await getContractFactory("AcrossConfigStore", signer)).deploy()) as AcrossConfigStore;
  const { blockNumber: deploymentBlock } = await configStore.deployTransaction.wait();

  for (const token of tokensToAdd) {
    await configStore.updateTokenConfig(
      token.address,
      JSON.stringify({
        rateModel: rateModel,
      })
    );
  }
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
    maxL1TokensPerPoolRebalanceLeaf.toString()
  );
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
    maxRefundPerRelayerRefundLeaf.toString()
  );

  if (additionalChainIdIndices) {
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([...PROTOCOL_DEFAULT_CHAIN_ID_INDICES, ...additionalChainIdIndices])
    );
  }
  return { configStore, deploymentBlock };
}

export function convertMockedConfigClient(client: unknown): client is AcrossConfigStoreClient {
  return true;
}

export async function deployAndConfigureHubPool(
  signer: SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: Contract }[],
  finderAddress: string = constants.zeroAddress,
  timerAddress: string = constants.zeroAddress
): Promise<{
  hubPool: Contract;
  mockAdapter: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  hubPoolDeploymentBlock: number;
}> {
  const lpTokenFactory = await (await getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, finderAddress, constants.zeroAddress, timerAddress);
  const receipt = await hubPool.deployTransaction.wait();

  const mockAdapter = await (await getContractFactory("Mock_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token_1 = await (await getContractFactory("ExpandedERC20", signer)).deploy("L1Token1", "L1Token1", 18);
  await l1Token_1.addMember(TokenRolesEnum.MINTER, signer.address);
  const l1Token_2 = await (await getContractFactory("ExpandedERC20", signer)).deploy("L1Token2", "L1Token2", 18);
  await l1Token_2.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token_1, l1Token_2, hubPoolDeploymentBlock: receipt.blockNumber };
}

export async function enableRoutesOnHubPool(
  hubPool: Contract,
  rebalanceRouteTokens: { destinationChainId: number; l1Token: Contract; destinationToken: Contract }[]
): Promise<void> {
  for (const tkn of rebalanceRouteTokens) {
    await hubPool.setPoolRebalanceRoute(tkn.destinationChainId, tkn.l1Token.address, tkn.destinationToken.address);
    await hubPool.enableL1TokenForLiquidityProvision(tkn.l1Token.address);
  }
}

export async function addLiquidity(
  signer: SignerWithAddress,
  hubPool: Contract,
  l1Token: Contract,
  amount: BigNumber
): Promise<void> {
  await seedWallet(signer, [l1Token], undefined, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}
