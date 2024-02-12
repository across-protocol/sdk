import hre from "hardhat";
import { ZERO_ADDRESS, EMPTY_MESSAGE } from "../src/constants";
import { SpokePoolClient } from "../src/clients";
import { Deposit, V3Deposit } from "../src/interfaces";
import { bnOne, findFillBlock, getCurrentTime, getNetworkName } from "../src/utils";
import { originChainId, destinationChainId } from "./constants";
import {
  assertPromiseError,
  Contract,
  SignerWithAddress,
  buildFill,
  fillV3Relay,
  createSpyLogger,
  deploySpokePoolWithToken,
  ethers,
  expect,
  setupTokensForWallet,
  toBNWei,
} from "./utils";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
let deploymentBlock: number;

const originChainId2 = originChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Fills", function () {
  const message = EMPTY_MESSAGE;
  const exclusivityDeadline = 0;
  const exclusiveRelayer = ZERO_ADDRESS;

  let quoteTimestamp: number;
  let fillDeadline: number;

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

    quoteTimestamp = Number(await spokePool.getCurrentTime());
    fillDeadline = quoteTimestamp + 600;
  });

  it("Correctly fetches fill data single fill, single chain", async function () {
    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp,
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message,
    };
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 1);
    await buildFill(spokePool, destErc20, depositor, relayer1, { ...deposit, depositId: 1 }, 1);
    await spokePoolClient.update();
    expect(spokePoolClient.getFills().length).to.equal(2);
  });
  it("Correctly fetches deposit data multiple fills, multiple chains", async function () {
    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp,
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message,
    };

    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2, 1 for the second
    // depositor on chain1, and 2 for the second depositor on chain2.
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer1, { ...deposit, originChainId: originChainId2 }, 0.1);

    await buildFill(spokePool, destErc20, depositor, relayer2, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer2, { ...deposit, originChainId: originChainId2 }, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer2, { ...deposit, originChainId: originChainId2 }, 0.1);

    await spokePoolClient.update();

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getFills().length).to.equal(6);

    // TODO: Add `getFillsForRepaymentChainId` tests once we update the `fillRelay` method from contracts-v2 to allow
    // an overridable `repaymentChainId`

    expect(spokePoolClient.getFillsForOriginChain(originChainId).length).to.equal(3);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2).length).to.equal(3);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address).length).to.equal(3);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address).length).to.equal(3);
  });

  it("Correctly locates the block number for a FilledV3Relay event", async function () {
    const nBlocks = 1_000;
    const inputAmount = toBNWei(1);

    const quoteTimestamp = getCurrentTime();
    const deposit: V3Deposit = {
      depositId: 0,
      originChainId,
      destinationChainId,
      depositor: depositor.address,
      recipient: depositor.address,
      inputToken: erc20.address,
      inputAmount,
      outputToken: destErc20.address,
      outputAmount: inputAmount.sub(1),
      quoteTimestamp,
      message,
      fillDeadline,
      exclusivityDeadline,
      exclusiveRelayer,
    };

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
    const inputAmount = toBNWei(1);

    const deposit: V3Deposit = {
      depositId: 0,
      originChainId,
      destinationChainId,
      depositor: depositor.address,
      recipient: depositor.address,
      inputToken: erc20.address,
      inputAmount,
      outputToken: destErc20.address,
      outputAmount: inputAmount.sub(bnOne),
      quoteTimestamp,
      message,
      fillDeadline,
      exclusivityDeadline,
      exclusiveRelayer,
    };

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
