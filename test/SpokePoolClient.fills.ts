import hre from "hardhat";
import { SpokePoolClient } from "../src/clients";
import { Deposit, RelayData } from "../src/interfaces";
import { findFillBlock, getNetworkName } from "../src/utils";
import {
  assertPromiseError,
  Contract,
  SignerWithAddress,
  buildFill,
  createSpyLogger,
  deploySpokePoolWithToken,
  destinationChainId,
  ethers,
  expect,
  originChainId,
  setupTokensForWallet,
  toBNWei,
} from "./utils";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
let deploymentBlock: number;

const originChainId2 = originChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Fills", function () {
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
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
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
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
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

  it("Correctly locates the block number for a FilledRelay event", async function () {
    const nBlocks = 1_000;

    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
    };

    // Submit the fill randomly within the next `nBlocks` blocks.
    const startBlock = await spokePool.provider.getBlockNumber();
    const targetFillBlock = startBlock + Math.floor(Math.random() * nBlocks);

    for (let i = 0; i < nBlocks; ++i) {
      const blockNumber = await spokePool.provider.getBlockNumber();
      if (blockNumber === targetFillBlock - 1) {
        await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 1);
        continue;
      }

      await hre.network.provider.send("evm_mine");
    }

    const fillBlock = await findFillBlock(spokePool, deposit as RelayData, startBlock);
    expect(fillBlock).to.equal(targetFillBlock);
  });

  it("FilledRelay block search: bounds checking", async function () {
    const nBlocks = 100;

    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
    };

    const startBlock = await spokePool.provider.getBlockNumber();
    for (let i = 0; i < nBlocks; ++i) {
      await hre.network.provider.send("evm_mine");
    }

    // No fill has been made, so expect an undefined fillBlock.
    const fillBlock = await findFillBlock(spokePool, deposit as RelayData, startBlock);
    expect(fillBlock).to.be.undefined;

    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 1);
    const lateBlockNumber = await spokePool.provider.getBlockNumber();
    await hre.network.provider.send("evm_mine");

    // Now search for the fill _after_ it was filled and expect an exception.
    const [srcChain, dstChain] = [getNetworkName(deposit.originChainId), getNetworkName(deposit.destinationChainId)];
    await assertPromiseError(
      findFillBlock(spokePool, deposit as RelayData, lateBlockNumber),
      `${srcChain} deposit ${deposit.depositId} filled on ${dstChain} before block`
    );

    // Should assert if highBlock <= lowBlock.
    await assertPromiseError(
      findFillBlock(spokePool, deposit as RelayData, await spokePool.provider.getBlockNumber()),
      "Block numbers out of range"
    );
  });
});
