import hre from "hardhat";
import { SpokePoolClient } from "../src/clients";
import { Deposit } from "../src/interfaces";
import { bnOne, bnZero, findFillBlock, findFillEvent, getMessageHash, getNetworkName, toBytes32 } from "../src/utils";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../src/constants";
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

    const message = EMPTY_MESSAGE;
    deposit = {
      depositId: bnZero,
      originChainId,
      destinationChainId,
      depositor: depositor.address,
      recipient: depositor.address,
      inputToken: erc20.address,
      inputAmount: outputAmount.add(bnOne),
      outputToken: destErc20.address,
      outputAmount: toBNWei("1"),
      quoteTimestamp: spokePoolTime - 60,
      message,
      messageHash: getMessageHash(message),
      fillDeadline: spokePoolTime + 600,
      exclusivityDeadline: 0,
      exclusiveRelayer: ZERO_ADDRESS,
      fromLiteChain: false,
      toLiteChain: false,
    };
  });

  it("Correctly fetches fill data single fill, single chain", async function () {
    await fillV3Relay(spokePool, deposit, relayer1);
    await fillV3Relay(spokePool, { ...deposit, depositId: deposit.depositId.add(1) }, relayer1);
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

  it("Correctly returns the FilledV3Relay event using the relay data", async function () {
    const targetDeposit = { ...deposit, depositId: deposit.depositId.add(1) };
    // Submit multiple fills at the same block:
    const startBlock = await spokePool.provider.getBlockNumber();
    await fillV3Relay(spokePool, deposit, relayer1);
    await fillV3Relay(spokePool, targetDeposit, relayer1);
    await fillV3Relay(spokePool, { ...deposit, depositId: deposit.depositId.add(2) }, relayer1);
    await hre.network.provider.send("evm_mine");

    let fill = await findFillEvent(spokePool, targetDeposit, startBlock);
    expect(fill).to.not.be.undefined;
    fill = fill!;

    expect(fill.depositId).to.equal(targetDeposit.depositId);

    // Looking for a fill can return undefined:
    const missingFill = await findFillEvent(spokePool, { ...deposit, depositId: deposit.depositId.add(3) }, startBlock);
    expect(missingFill).to.be.undefined;
  });

  it("FilledV3Relay block search: bounds checking", async function () {
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
      `${srcChain} deposit ${deposit.depositId.toString()} filled on `
    );

    // Should assert if highBlock <= lowBlock.
    await assertPromiseError(
      findFillBlock(spokePool, deposit, await spokePool.provider.getBlockNumber()),
      "Block numbers out of range"
    );
  });
});
