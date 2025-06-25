import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient, signAndSendTransaction } from "@across-protocol/contracts";
import { intToU8Array32 } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { KeyPairSigner, fetchEncodedAccount } from "@solana/kit";
import { hexlify } from "ethers/lib/utils";
import {
  SVM_DEFAULT_ADDRESS,
  createCloseFillPdaInstruction,
  findFillEvent,
  getRandomSvmAddress,
} from "../src/arch/svm";
import { SVMSpokePoolClient } from "../src/clients";
import { Deposit, FillStatus } from "../src/interfaces";
import { SvmQuery, SymbolMappingType } from "../src/relayFeeCalculator";
import {
  BigNumber,
  EvmAddress,
  SvmAddress,
  getCurrentTime,
  getRandomInt,
  randomAddress,
  toAddressType,
} from "../src/utils";
import { signer } from "./Solana.setup";
import { createSpyLogger, expect } from "./utils";
import {
  createDefaultSolanaClient,
  createMint,
  formatRelayData,
  mintTokens,
  sendCreateFill,
  sendRequestSlowFill,
  setCurrentTime,
} from "./utils/svm/utils";

describe("SVMSpokePoolClient: Fills", function () {
  const solanaClient = createDefaultSolanaClient();

  let mint: KeyPairSigner;
  let decimals: number;

  // SpokePoolClient:
  let spokePoolClient: SVMSpokePoolClient;

  // Relay data:
  let depositor: EvmAddress;
  let recipient: SvmAddress;
  let inputToken: EvmAddress;
  let relayData: SvmSpokeClient.RelayDataArgs;
  let depositId: number;

  before(async function () {
    ({ mint, decimals } = await createMint(signer, solanaClient));

    // set default relay data
    // @note: this file is testing fill related functions. Then, origin values use evm addresses and destination values use svm addresses
    depositor = EvmAddress.from(randomAddress());
    recipient = SvmAddress.from(getRandomSvmAddress());
    inputToken = EvmAddress.from(randomAddress());
    depositId = getRandomInt();
    relayData = {
      depositor,
      recipient,
      exclusiveRelayer: toAddressType(SVM_DEFAULT_ADDRESS, CHAIN_IDs.SOLANA),
      inputToken,
      outputToken: toAddressType(mint.address, CHAIN_IDs.SOLANA),
      inputAmount: 10,
      outputAmount: 9,
      originChainId: CHAIN_IDs.MAINNET,
      depositId: new Uint8Array(intToU8Array32(depositId)),
      fillDeadline: getCurrentTime() + 3600,
      exclusivityDeadline: 0,
      message: new Uint8Array(),
    };

    // Instantiate SpokePoolClient
    spokePoolClient = await SVMSpokePoolClient.create(
      createSpyLogger().spyLogger,
      null,
      CHAIN_IDs.SOLANA,
      0n,
      undefined,
      solanaClient.rpc
    );
  });

  it("Correctly returns a Fill event using the relay data", async function () {
    // Format Solana input types to SpokeClient types
    const formattedRelayData = formatRelayData(relayData);

    // Submit fill event:
    await mintTokens(signer, solanaClient, mint.address, BigInt(relayData.outputAmount));
    await sendCreateFill(solanaClient, signer, mint, decimals, relayData);

    // Look for the fill event:
    let fill = await findFillEvent(
      formattedRelayData,
      CHAIN_IDs.SOLANA,
      spokePoolClient.svmEventsClient,
      spokePoolClient.deploymentBlock
    );
    expect(fill).to.not.be.undefined;
    fill = fill!;

    expect(fill.depositId).to.equal(relayData.depositId);

    // Looking for a fill can return undefined:
    const missingFill = await findFillEvent(
      { ...formattedRelayData, depositId: BigNumber.from(depositId + 1) },
      CHAIN_IDs.SOLANA,
      spokePoolClient.svmEventsClient,
      spokePoolClient.deploymentBlock
    );
    expect(missingFill).to.be.undefined;
  });

  it("Correctly returns the fill status of a given relay data", async function () {
    // Set relay data:
    const targetRelayData = { ...relayData, depositId: new Uint8Array(intToU8Array32(depositId + 2)) };
    // Format Solana input types to SpokeClient types
    const formattedRelayData = formatRelayData(targetRelayData);

    // Submit fill event:
    const currentSlot = await solanaClient.rpc.getSlot().send();
    await mintTokens(signer, solanaClient, mint.address, BigInt(targetRelayData.outputAmount));
    await sendCreateFill(solanaClient, signer, mint, decimals, targetRelayData);

    // Get fill status before fill slot:
    const fillStatusBeforeFill = await spokePoolClient.relayFillStatus(
      formattedRelayData,
      Number(currentSlot) - 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusBeforeFill).to.equal(FillStatus.Unfilled);

    // Get fill status after fill slot:
    const fillStatusAfterFill = await spokePoolClient.relayFillStatus(
      formattedRelayData,
      Number(currentSlot) + 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusAfterFill).to.equal(FillStatus.Filled);

    // Get fill status for an unfilled relay data:
    const unfilledRelayData = { ...formattedRelayData, depositId: BigNumber.from(depositId + 3) };
    const fillStatusUnfilledRelay = await spokePoolClient.relayFillStatus(
      unfilledRelayData,
      Number(currentSlot) + 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusUnfilledRelay).to.equal(FillStatus.Unfilled);
  });

  it("Returns correct fill status for multiple relay data entries", async function () {
    // Set relay data entries:
    const relayDataEntries = [
      { ...relayData, depositId: new Uint8Array(intToU8Array32(depositId + 10)) },
      { ...relayData, depositId: new Uint8Array(intToU8Array32(depositId + 11)) },
      { ...relayData, depositId: new Uint8Array(intToU8Array32(depositId + 12)) },
    ];

    // Submit fill events:
    const currentSlot = await solanaClient.rpc.getSlot().send();
    await mintTokens(
      signer,
      solanaClient,
      mint.address,
      BigInt(relayData.outputAmount) * BigInt(relayDataEntries.length)
    );
    await sendCreateFill(solanaClient, signer, mint, decimals, relayDataEntries[0]); // For depositId + 10
    await sendRequestSlowFill(solanaClient, signer, relayDataEntries[1]); // For depositId + 11
    // Skip relay data with depositId + 12

    // Get fill status for all relay data entries before fills:
    // @note: by providing a slot number, status is reconstructed from events
    const fillStatusArray = await spokePoolClient.fillStatusArray(
      relayDataEntries.map((entry) => formatRelayData(entry)),
      Number(currentSlot) - 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusArray).to.deep.equal([FillStatus.Unfilled, FillStatus.Unfilled, FillStatus.Unfilled]);

    // Get fill status for all relay data entries after fills:
    // @note: since we didn't provide a slot number, status is reconstructed at current slot from the fill status pdas
    const fillStatusArrayAfterFills = await spokePoolClient.fillStatusArray(
      relayDataEntries.map((entry) => formatRelayData(entry))
    );
    expect(fillStatusArrayAfterFills).to.deep.equal([
      FillStatus.Filled,
      FillStatus.RequestedSlowFill,
      FillStatus.Unfilled, // Last relay was not filled
    ]);
  });

  it("Correctly returns fill status when a slow fill is requested", async function () {
    // Set relay data:
    const targetRelayData = { ...relayData, depositId: new Uint8Array(intToU8Array32(depositId + 15)) };
    // Format Solana input types to SpokeClient types
    const formattedRelayData = formatRelayData(targetRelayData);

    // Submit slow fill request:
    const currentSlot = await solanaClient.rpc.getSlot().send();
    await sendRequestSlowFill(solanaClient, signer, targetRelayData);

    // Get fill status before slow fill request:
    const fillStatusBeforeRequest = await spokePoolClient.relayFillStatus(
      formattedRelayData,
      Number(currentSlot) - 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusBeforeRequest).to.equal(FillStatus.Unfilled);

    // Get fill status after slow fill request:
    const fillStatusAfterRequest = await spokePoolClient.relayFillStatus(
      formattedRelayData,
      Number(currentSlot) + 10,
      CHAIN_IDs.SOLANA
    );
    expect(fillStatusAfterRequest).to.equal(FillStatus.RequestedSlowFill);
  });

  it("Closes the fill pda after the fill deadline has passed", async () => {
    const currentSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentSlotTimestamp = await solanaClient.rpc.getBlockTime(currentSlot).send();
    const fillDeadline = Number(currentSlotTimestamp) + 1;
    await setCurrentTime(signer, solanaClient, Number(currentSlotTimestamp));
    const newRelayData = { ...relayData, depositId: new Uint8Array(intToU8Array32(getRandomInt())), fillDeadline };
    const formattedRelayData = formatRelayData(newRelayData);
    await mintTokens(signer, solanaClient, mint.address, BigInt(relayData.outputAmount));
    const { fillInput, relayData: fillRelayData } = await sendCreateFill(
      solanaClient,
      signer,
      mint,
      decimals,
      newRelayData
    );

    const fillStatusAfterFill = await spokePoolClient.relayFillStatus(formattedRelayData);
    expect(fillStatusAfterFill).to.equal(FillStatus.Filled);

    try {
      const closePdaInstruction = await createCloseFillPdaInstruction(signer, solanaClient.rpc, fillInput.fillStatus);
      await signAndSendTransaction(solanaClient, closePdaInstruction);
    } catch (error) {
      expect(error.context.logs.some((log) => log.includes("The fill deadline has not passed!"))).to.be.true;
    }

    await setCurrentTime(signer, solanaClient, fillRelayData.fillDeadline + 1);

    const closePdaInstruction = await createCloseFillPdaInstruction(signer, solanaClient.rpc, fillInput.fillStatus);
    await signAndSendTransaction(solanaClient, closePdaInstruction);

    const fillStatusAccount = await fetchEncodedAccount(solanaClient.rpc, fillInput.fillStatus, {
      commitment: "confirmed",
    });

    expect(fillStatusAccount.exists).to.be.false;

    const fillStatusWithPdaClosed = await spokePoolClient.relayFillStatus(formattedRelayData);
    expect(fillStatusWithPdaClosed).to.equal(FillStatus.Filled);
  });

  it("Calculates the gas cost of a fill", async function () {
    const currentSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentSlotTimestamp = await solanaClient.rpc.getBlockTime(currentSlot).send();
    const fillDeadline = Number(currentSlotTimestamp) + 1;
    await setCurrentTime(signer, solanaClient, Number(currentSlotTimestamp));
    const newRelayData = { ...relayData, depositId: new Uint8Array(intToU8Array32(getRandomInt())), fillDeadline };

    await mintTokens(signer, solanaClient, mint.address, BigInt(relayData.outputAmount));

    const symbolMapping: SymbolMappingType = {
      USDC: {
        addresses: {
          [CHAIN_IDs.SOLANA]: "So11111111111111111111111111111111111111112",
        },
        decimals: 6,
      },
    };
    const svmQuery = new SvmQuery(
      solanaClient.rpc,
      symbolMapping,
      SvmAddress.from(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
      SvmAddress.from(signer.address),
      createSpyLogger().spyLogger
    );

    const depositData: Omit<Deposit, "messageHash"> = {
      depositor: newRelayData.depositor,
      recipient: newRelayData.recipient,
      exclusiveRelayer: newRelayData.exclusiveRelayer,
      inputToken: newRelayData.inputToken,
      outputToken: newRelayData.outputToken,
      fillDeadline: newRelayData.fillDeadline,
      exclusivityDeadline: newRelayData.exclusivityDeadline,
      destinationChainId: CHAIN_IDs.SOLANA,
      quoteTimestamp: getCurrentTime(),
      fromLiteChain: false,
      toLiteChain: false,
      inputAmount: BigNumber.from(newRelayData.inputAmount),
      outputAmount: BigNumber.from(newRelayData.outputAmount),
      originChainId: Number(newRelayData.originChainId),
      depositId: BigNumber.from(newRelayData.depositId),
      message: hexlify(newRelayData.message),
    };

    const gasCosts = await svmQuery.getGasCosts(depositData, toAddressType(signer.address, CHAIN_IDs.SOLANA));

    const nativeGasCost = await svmQuery.getNativeGasCost(depositData, toAddressType(signer.address, CHAIN_IDs.SOLANA));

    expect(nativeGasCost).to.equal(gasCosts.nativeGasCost);

    const { signature } = await sendCreateFill(solanaClient, signer, mint, decimals, newRelayData);

    const receipt = await solanaClient.rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .send();

    const actualGasUnits = receipt?.meta?.computeUnitsConsumed || BigInt(0);
    const expectedGasUnits = gasCosts.nativeGasCost.toBigInt();

    const diff =
      actualGasUnits > expectedGasUnits ? actualGasUnits - expectedGasUnits : expectedGasUnits - actualGasUnits;

    const percentageDiff = Number(diff * BigInt(100)) / Number(expectedGasUnits);
    const maxPercentageDiff = 15; // 15%
    expect(percentageDiff).to.be.lessThan(
      maxPercentageDiff,
      `Gas usage difference too high: ${percentageDiff.toFixed(2)}%`
    );
  });
});
