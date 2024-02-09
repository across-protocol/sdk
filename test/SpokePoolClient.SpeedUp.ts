import { EMPTY_MESSAGE } from "../src/constants";
import { SpokePoolClient } from "../src/clients";
import { DepositWithBlock, V2DepositWithBlock, V3Deposit, V3DepositWithBlock, V3SpeedUp } from "../src/interfaces";
import { bnOne, isV3Deposit } from "../src/utils";
import { depositRelayerFeePct, destinationChainId, getUpdatedV3DepositSignature, modifyRelayHelper } from "./constants";
import {
  assert,
  assertPromisePasses,
  assertPromiseError,
  Contract,
  BigNumber,
  SignerWithAddress,
  createSpyLogger,
  deepEqualsWithBigNumber,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutes,
  ethers,
  expect,
  originChainId,
  setupTokensForWallet,
  simpleDeposit,
  toBNWei,
} from "./utils";

describe("SpokePoolClient: SpeedUp", function () {
  const ignoredFields = [
    "blockNumber",
    "blockTimestamp",
    "logIndex",
    "quoteBlockNumber",
    "transactionHash",
    "transactionIndex",
  ];

  const destinationChainId2 = destinationChainId + 1;
  const message = EMPTY_MESSAGE;

  let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
  let depositor: SignerWithAddress, deploymentBlock: number;
  let spokePoolClient: SpokePoolClient;
  let balance: BigNumber;
  let inputToken: string, outputToken: string;
  let inputAmount: BigNumber, outputAmount: BigNumber;

  beforeEach(async function () {
    [, depositor] = await ethers.getSigners();
  });

  beforeEach(async function () {
    ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId, deploymentBlock);

    await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);
    balance = await erc20.connect(depositor).balanceOf(depositor.address);
    inputToken = erc20.address;
    outputToken = destErc20.address;
    inputAmount = balance;
    outputAmount = inputAmount.sub(bnOne);
  });

  it("v2: Fetches speedup data associated with a deposit", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // Before speedup should return the normal deposit object.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock)).to.deep.equal(deposit);

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      message,
      speedUpSignature.signature
    );
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpSignature.signature,
      newRelayerFeePct: newRelayFeePct,
      updatedMessage: deposit.message,
      updatedRecipient: deposit.recipient,
    };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;

    // Fetching deposits for the depositor should contain the correct fees.
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        ignoredFields
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });

  it("v3: Fetches speedup data associated with a deposit", async function () {
    const deposit = await depositV3(
      spokePool,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await spokePoolClient.update();

    // Should return the normal deposit object before any update is applied.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);

    const updatedOutputAmount = deposit.outputAmount.sub(bnOne);
    const updatedRecipient = deposit.recipient;
    const updatedMessage = deposit.message;
    const signature = await getUpdatedV3DepositSignature(
      depositor,
      deposit.depositId,
      originChainId,
      updatedOutputAmount,
      updatedRecipient,
      updatedMessage
    );

    await spokePool
      .connect(depositor)
      .speedUpV3Deposit(
        depositor.address,
        deposit.depositId,
        updatedOutputAmount,
        updatedRecipient,
        updatedMessage,
        signature
      );
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData: V3Deposit = {
      ...deposit,
      speedUpSignature: signature,
      updatedOutputAmount,
      updatedMessage,
      updatedRecipient,
    };

    expect(deepEqualsWithBigNumber(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit), expectedDepositData)).to
      .be.true;

    // Fetching deposits for the depositor should contain the correct fees.
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        [...ignoredFields, "realizedLpFeePct"]
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });

  it("v2: Fetches speedup data associated with an early deposit", async function () {
    const delta = await spokePool.depositQuoteTimeBuffer();
    const now = Number(await spokePool.getCurrentTime());

    await spokePool.setCurrentTime(now + delta);
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePool.setCurrentTime(now);
    await spokePoolClient.update();

    // Before speedup should return the normal deposit object.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock)).to.deep.equal(deposit);

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      deposit.message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      deposit.message,
      speedUpSignature.signature
    );
    await spokePoolClient.update();

    // Deposit is not returned until we reach deposit.quoteTimestamp.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(0);
    await spokePool.setCurrentTime(deposit.quoteTimestamp);

    // Clear out spoke pool client data and re-update so that it should now see the formerly "early" deposit.
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId, deploymentBlock);
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpSignature.signature,
      newRelayerFeePct: newRelayFeePct,
      updatedMessage: deposit.message,
      updatedRecipient: deposit.recipient,
    };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;
    // Fetching deposits for the depositor should contain the correct fees.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        ignoredFields
      )
    ).to.be.true;
  });

  it("v2: Selects the highest speedup option when multiple are presented", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    // Speedup below the original fee should not update to use the new fee.
    const newLowerRelayFeePct = depositRelayerFeePct.sub(toBNWei(0.01));
    const speedUpSignature = await modifyRelayHelper(
      newLowerRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      deposit.message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newLowerRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      deposit.message,
      speedUpSignature.signature
    );
    await spokePoolClient.update();
    // below the original fee should equal the original deposit with no signature.
    expect(
      deepEqualsWithBigNumber(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock), deposit)
    ).to.be.true;
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        deposit,
        ignoredFields
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
    expect(spokePoolClient.getDeposits()[0].speedUpSignature).to.deep.equal(undefined);

    // SpeedUp the deposit twice. Ensure the highest fee (and signature) is used.

    const speedupFast = toBNWei(0.1337);
    const speedUpFastSignature = await modifyRelayHelper(
      speedupFast,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      deposit.message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      speedupFast,
      deposit.depositId,
      deposit.recipient,
      deposit.message,
      speedUpFastSignature.signature
    );
    const speedupFaster = toBNWei(0.1338);
    const speedUpFasterSignature = await modifyRelayHelper(
      speedupFaster,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      deposit.message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      speedupFaster,
      deposit.depositId,
      deposit.recipient,
      deposit.message,
      speedUpFasterSignature.signature
    );
    await spokePoolClient.update();

    // Should use the faster data between the two speedups.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpFasterSignature.signature,
      newRelayerFeePct: speedupFaster,
      updatedMessage: deposit.message,
      updatedRecipient: deposit.recipient,
    };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        ignoredFields
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });

  it("v3: Selects the lowest outputAtmount when multiple are presented", async function () {
    const deposit = await depositV3(
      spokePool,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await spokePoolClient.update();

    // Should return the normal deposit object before any update is applied.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);

    const depositUpdates: V3SpeedUp[] = [];
    const { depositId, recipient: updatedRecipient, message: updatedMessage } = deposit;
    for (const updatedOutputAmount of [outputAmount.add(1), outputAmount, outputAmount.sub(1), outputAmount.sub(2)]) {
      const depositorSignature = await getUpdatedV3DepositSignature(
        depositor,
        depositId,
        originChainId,
        updatedOutputAmount,
        updatedRecipient,
        updatedMessage
      );

      await spokePool
        .connect(depositor)
        .speedUpV3Deposit(
          depositor.address,
          depositId,
          updatedOutputAmount,
          updatedRecipient,
          updatedMessage,
          depositorSignature
        );

      depositUpdates.push({
        depositorSignature,
        updatedOutputAmount,
        depositId,
        depositor: depositor.address,
        originChainId,
        updatedRecipient,
        updatedMessage,
      });

      const bestDepositUpdate = depositUpdates.reduce((prev, current) =>
        current.updatedOutputAmount.lt(prev.updatedOutputAmount) ? current : prev
      );
      const lowestOutputAmount = bestDepositUpdate.updatedOutputAmount.lt(outputAmount)
        ? bestDepositUpdate.updatedOutputAmount
        : outputAmount;

      await spokePoolClient.update();
      let updatedDeposit = spokePoolClient
        .getDepositsForDestinationChain(deposit.destinationChainId)
        .filter(isV3Deposit<V3DepositWithBlock, V2DepositWithBlock>)
        .at(-1);

      // Convoluted checks to help tsc narrow types.
      assert.exists(updatedDeposit);
      assert.equal(isV3Deposit(updatedDeposit!), true);
      updatedDeposit = updatedDeposit!;

      if (lowestOutputAmount.eq(deposit.outputAmount)) {
        expect(updatedDeposit.updatedOutputAmount).to.be.undefined;
        expect(updatedDeposit.speedUpSignature).to.be.undefined;
        expect(updatedDeposit.updatedRecipient).to.be.undefined;
        expect(updatedDeposit.updatedMessage).to.be.undefined;
      } else {
        expect(updatedDeposit.updatedOutputAmount!.eq(bestDepositUpdate.updatedOutputAmount)).to.be.true;
        expect(updatedDeposit.speedUpSignature).to.equal(bestDepositUpdate.depositorSignature);
        expect(updatedDeposit.updatedRecipient).to.equal(bestDepositUpdate.updatedRecipient);
        expect(updatedDeposit.updatedMessage).to.equal(bestDepositUpdate.updatedMessage);
      }
    }
  });

  it("v2: Receives a speed up for a correct depositor but invalid deposit Id", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // change deposit ID to some invalid value
    deposit.depositId = ++deposit.depositId;

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      deposit.message
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      deposit.message,
      speedUpSignature.signature
    );

    await assertPromisePasses(spokePoolClient.update());
  });

  it("v3: Ignores invalid updates", async function () {
    const deposit = await depositV3(
      spokePool,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await spokePoolClient.update();

    // Should return the normal deposit object before any update is applied.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);

    const { depositId, originChainId, recipient: updatedRecipient, message: updatedMessage } = deposit;
    const updatedOutputAmount = deposit.outputAmount.sub(bnOne);

    // Independently toggle originChainId, depositId and depositor. Verify that a mismatch on these fields is not
    // attributed to the existing deposit.
    for (const field of ["originChainId", "depositId", "depositor"]) {
      const testOriginChainId = field !== "originChainId" ? originChainId : originChainId + 1;
      const testDepositId = field !== "depositId" ? depositId : depositId + 1;
      const testDepositor = field !== "depositor" ? depositor : (await ethers.getSigners())[0];
      assert.isTrue(field !== "depositor" || testDepositor.address !== depositor.address); // Sanity check

      const signature = await getUpdatedV3DepositSignature(
        testDepositor,
        testDepositId,
        testOriginChainId,
        updatedOutputAmount,
        updatedRecipient,
        updatedMessage
      );

      const speedUp = spokePool
        .connect(depositor)
        .speedUpV3Deposit(
          testDepositor.address,
          testDepositId,
          updatedOutputAmount,
          updatedRecipient,
          updatedMessage,
          signature
        );

      if (field === "originChainId") {
        // Mismatched originChainId gets caught by the SpokePool contract.
        await assertPromiseError(speedUp);
      }

      // The updated deposit information should never be attached to the
      // deposit.
      expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);
    }
  });
});
