import hre from "hardhat";
import { SpokePoolClient } from "../src/clients";
import { Deposit, FillStatus, RelayData } from "../src/interfaces";
import { assert, bnOne, getNetworkName, relayFillStatus } from "../src/utils";
import { CHAIN_IDs, EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
import { originChainId, destinationChainId } from "./constants";
import {
  assertPromiseError,
  Contract,
  SignerWithAddress,
  fillV3Relay,
  createSpyLogger,
  deploySpokePoolWithToken,
  ethers,
  expect,
  setupTokensForWallet,
  toBNWei,
} from "./utils";

/**
 * Find the block at which a fill was completed.
 * @todo After SpokePool upgrade, this function can be simplified to use the FillStatus enum.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param lowBlockNumber The lower bound of the search. Must be bounded by SpokePool deployment.
 * @param highBlocknumber Optional upper bound for the search.
 * @returns The block number at which the relay was completed, or undefined.
 */
export async function findFillBlock(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<number | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} > ${highBlockNumber})`);

  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query becasue the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  // @todo Sub out actual chain IDs w/ CHAIN_IDs constants
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await provider.getNetwork()).chainId
    : Number(await spokePool.chainId());

  assert(
    relayData.originChainId !== destinationChainId,
    `Origin & destination chain IDs must not be equal (${destinationChainId})`
  );

  // Make sure the relay war completed within the block range supplied by the caller.
  const [initialFillStatus, finalFillStatus] = (
    await Promise.all([
      relayFillStatus(spokePool, relayData, lowBlockNumber, destinationChainId),
      relayFillStatus(spokePool, relayData, highBlockNumber, destinationChainId),
    ])
  ).map(Number);

  if (finalFillStatus !== FillStatus.Filled) {
    return undefined; // Wasn't filled within the specified block range.
  }

  // Was filled earlier than the specified lowBlock. This is an error by the caller.
  if (initialFillStatus === FillStatus.Filled) {
    const { depositId, originChainId } = relayData;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    throw new Error(`${srcChain} deposit ${depositId} filled on ${dstChain} before block ${lowBlockNumber}`);
  }

  // Find the leftmost block where filledAmount equals the deposit amount.
  do {
    const midBlockNumber = Math.floor((highBlockNumber + lowBlockNumber) / 2);
    const fillStatus = await relayFillStatus(spokePool, relayData, midBlockNumber, destinationChainId);

    if (fillStatus === FillStatus.Filled) {
      highBlockNumber = midBlockNumber;
    } else {
      lowBlockNumber = midBlockNumber + 1;
    }
  } while (lowBlockNumber < highBlockNumber);

  return lowBlockNumber;
}

describe("SpokePoolClient: Fills", function () {
  const originChainId2 = originChainId + 1;

  let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
  let depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
  let spokePoolClient: SpokePoolClient;
  let deploymentBlock: number;
  let deposit: Deposit;

  beforeEach(async function () {
    [, depositor, relayer1, relayer2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken(
      originChainId,
      destinationChainId
    ));
    await spokePool.setChainId(destinationChainId); // The spoke pool for a fill should be at the destinationChainId.

    spokePoolClient = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      null,
      destinationChainId,
      deploymentBlock
    );

    await setupTokensForWallet(spokePool, relayer1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, relayer2, [erc20, destErc20], weth, 10);

    const spokePoolTime = Number(await spokePool.getCurrentTime());
    const outputAmount = toBNWei(1);
    deposit = {
      depositId: 0,
      originChainId,
      destinationChainId,
      depositor: depositor.address,
      recipient: depositor.address,
      inputToken: erc20.address,
      inputAmount: outputAmount.add(bnOne),
      outputToken: destErc20.address,
      outputAmount: toBNWei("1"),
      quoteTimestamp: spokePoolTime - 60,
      message: EMPTY_MESSAGE,
      fillDeadline: spokePoolTime + 600,
      exclusivityDeadline: 0,
      exclusiveRelayer: ZERO_ADDRESS,
      fromLiteChain: false,
      toLiteChain: false,
    };
  });

  it("Correctly fetches fill data single fill, single chain", async function () {
    await fillV3Relay(spokePool, deposit, relayer1);
    await fillV3Relay(spokePool, { ...deposit, depositId: deposit.depositId + 1 }, relayer1);
    await spokePoolClient.update();
    expect(spokePoolClient.getFills().length).to.equal(2);
  });

  it("Correctly fetches deposit data multiple fills, multiple chains", async function () {
    // Mix and match various fields to produce unique fills and verify they are all recorded by the SpokePoolClient.
    await fillV3Relay(spokePool, deposit, relayer1);
    await fillV3Relay(spokePool, { ...deposit, originChainId: originChainId2 }, relayer1);
    await fillV3Relay(spokePool, { ...deposit, inputAmount: deposit.inputAmount.add(bnOne) }, relayer1);
    await fillV3Relay(spokePool, { ...deposit, inputAmount: deposit.outputAmount.sub(bnOne) }, relayer2);

    await spokePoolClient.update();

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getFills().length).to.equal(4);

    expect(spokePoolClient.getFillsForOriginChain(originChainId).length).to.equal(3);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2).length).to.equal(1);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address).length).to.equal(3);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address).length).to.equal(1);
  });

  it("Correctly locates the block number for a FilledV3Relay event", async function () {
    const nBlocks = 1_000;

    // Submit the fill randomly within the next `nBlocks` blocks.
    const startBlock = await spokePool.provider.getBlockNumber();
    const targetFillBlock = startBlock + Math.floor(Math.random() * nBlocks);

    for (let i = 0; i < nBlocks; ++i) {
      const blockNumber = await spokePool.provider.getBlockNumber();
      if (blockNumber === targetFillBlock - 1) {
        const { blockNumber: fillBlockNumber } = await fillV3Relay(spokePool, deposit, relayer1);
        expect(fillBlockNumber).to.equal(targetFillBlock);
        continue;
      }

      await hre.network.provider.send("evm_mine");
    }

    const fillBlock = await findFillBlock(spokePool, deposit, startBlock);
    expect(fillBlock).to.equal(targetFillBlock);
  });

  it("FilledRelay block search: bounds checking", async function () {
    const nBlocks = 100;
    const startBlock = await spokePool.provider.getBlockNumber();
    for (let i = 0; i < nBlocks; ++i) {
      await hre.network.provider.send("evm_mine");
    }

    // No fill has been made, so expect an undefined fillBlock.
    const fillBlock = await findFillBlock(spokePool, deposit, startBlock);
    expect(fillBlock).to.be.undefined;

    const { blockNumber: lateBlockNumber } = await fillV3Relay(spokePool, deposit, relayer1);
    await hre.network.provider.send("evm_mine");

    // Now search for the fill _after_ it was filled and expect an exception.
    const srcChain = getNetworkName(deposit.originChainId);
    await assertPromiseError(
      findFillBlock(spokePool, deposit, lateBlockNumber),
      `${srcChain} deposit ${deposit.depositId} filled on `
    );

    // Should assert if highBlock <= lowBlock.
    await assertPromiseError(
      findFillBlock(spokePool, deposit, await spokePool.provider.getBlockNumber()),
      "Block numbers out of range"
    );
  });
});
