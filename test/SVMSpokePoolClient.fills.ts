import { KeyPairSigner, address, fetchEncodedAccount } from "@solana/kit";
import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { intToU8Array32 } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { createSpyLogger, expect } from "./utils";
import { FillStatus } from "../src/interfaces";
import { BigNumber, EvmAddress, getCurrentTime, getRandomInt, randomAddress, SvmAddress } from "../src/utils";
import {
  createMint,
  createDefaultSolanaClient,
  sendCreateFill,
  formatRelayData,
  mintTokens,
  sendRequestSlowFill,
  closeFillPda,
  setCurrentTime,
} from "./utils/svm/utils";
import { SVM_DEFAULT_ADDRESS, findFillEvent, getRandomSvmAddress } from "../src/arch/svm";
import { SvmSpokePoolClient } from "../src/clients";
import { signer } from "./Solana.setup";
describe("SVMSpokePoolClient: Fills", function () {
  const solanaClient = createDefaultSolanaClient();

  let mint: KeyPairSigner;
  let decimals: number;

  // SpokePoolClient:
  let spokePoolClient: SvmSpokePoolClient;

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
      depositor: address(depositor.toBase58()),
      recipient: address(recipient.toBase58()),
      exclusiveRelayer: SVM_DEFAULT_ADDRESS,
      inputToken: address(inputToken.toBase58()),
      outputToken: mint.address,
      inputAmount: 10,
      outputAmount: 9,
      originChainId: CHAIN_IDs.MAINNET,
      depositId: new Uint8Array(intToU8Array32(depositId)),
      fillDeadline: getCurrentTime() + 3600,
      exclusivityDeadline: 0,
      message: new Uint8Array(),
    };

    // Instantiate SpokePoolClient
    spokePoolClient = await SvmSpokePoolClient.create(
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

  it.only("Correctly returns the fill status after closing the fill pda", async () => {
    const formattedRelayData = formatRelayData(relayData);
    await mintTokens(signer, solanaClient, mint.address, BigInt(relayData.outputAmount));
    const { fillInput, relayData: fillRelayData } = await sendCreateFill(solanaClient, signer, mint, decimals, relayData);

    const fillStatusAfterFill = await spokePoolClient.relayFillStatus(formattedRelayData);
    expect(fillStatusAfterFill).to.equal(FillStatus.Filled);

    try {
      await closeFillPda(signer, solanaClient, fillInput.fillStatus);
    } catch (error) {
      expect(error.context.logs.some((log) => log.includes("The fill deadline has not passed!"))).to.be.true;
    }

    await setCurrentTime(signer, solanaClient, fillRelayData.fillDeadline + 1);

    await closeFillPda(signer, solanaClient, fillInput.fillStatus).catch((error) => {
      console.log(error.context.logs);
    });

    const fillStatusAccount = await fetchEncodedAccount(solanaClient.rpc, fillInput.fillStatus, { commitment: "confirmed" })

    expect(fillStatusAccount.exists).to.be.false;
  });
});
