import { EVMSpokePoolClient, SpokePoolClient } from "../src/clients";
import { Deposit, SpeedUp } from "../src/interfaces";
import { bnOne, getMessageHash, toBytes32 } from "../src/utils";
import { destinationChainId, originChainId } from "./constants";
import {
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
  getUpdatedV3DepositSignature,
  setupTokensForWallet,
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
    spokePoolClient = new EVMSpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      null,
      originChainId,
      deploymentBlock
    );

    await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);
    balance = await erc20.connect(depositor).balanceOf(depositor.address);
    inputToken = erc20.address;
    outputToken = destErc20.address;
    inputAmount = balance;
    outputAmount = inputAmount.sub(bnOne);
  });

  it("Fetches speedup data associated with a deposit", async function () {
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
      toBytes32(updatedRecipient),
      updatedMessage
    );

    await spokePool
      .connect(depositor)
      .speedUpDeposit(
        toBytes32(depositor.address),
        deposit.depositId,
        updatedOutputAmount,
        toBytes32(updatedRecipient),
        updatedMessage,
        signature
      );

    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData: Deposit = {
      ...deposit,
      messageHash: getMessageHash(deposit.message),
      speedUpSignature: signature,
      updatedOutputAmount,
      updatedMessage,
      updatedRecipient,
    };
    const updatedDeposit = spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit);
    expect(deepEqualsWithBigNumber(updatedDeposit, expectedDepositData)).to.be.true;

    // Fetching deposits for the depositor should contain the correct fees.
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        [...ignoredFields, "realizedLpFeePct", "fromLiteChain", "toLiteChain"]
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });

  it("Selects the lowest outputAmount when multiple are presented", async function () {
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

    const depositUpdates: SpeedUp[] = [];
    const { depositId, recipient: updatedRecipient, message: updatedMessage } = deposit;
    for (const updatedOutputAmount of [outputAmount.add(1), outputAmount, outputAmount.sub(1), outputAmount.sub(2)]) {
      const depositorSignature = await getUpdatedV3DepositSignature(
        depositor,
        depositId,
        originChainId,
        updatedOutputAmount,
        toBytes32(updatedRecipient),
        updatedMessage
      );

      await spokePool
        .connect(depositor)
        .speedUpDeposit(
          toBytes32(depositor.address),
          depositId,
          updatedOutputAmount,
          toBytes32(updatedRecipient),
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
      let updatedDeposit = spokePoolClient.getDepositsForDestinationChain(deposit.destinationChainId).at(-1);

      // Convoluted checks to help tsc narrow types.
      expect(updatedDeposit).to.exist;
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

  it("Ignores invalid updates", async function () {
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
      const testDepositId = field !== "depositId" ? depositId : depositId.add(1);
      const testDepositor = field !== "depositor" ? depositor : (await ethers.getSigners())[0];
      expect(field !== "depositor" || testDepositor.address !== depositor.address).to.be.true; // Sanity check

      const signature = await getUpdatedV3DepositSignature(
        testDepositor,
        testDepositId,
        testOriginChainId,
        updatedOutputAmount,
        toBytes32(updatedRecipient),
        updatedMessage
      );

      const speedUp = spokePool
        .connect(depositor)
        .speedUpV3Deposit(
          testDepositor.address,
          testDepositId,
          updatedOutputAmount,
          toBytes32(updatedRecipient),
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
