import { SvmSpokeClient } from "@across-protocol/contracts";
import { getSolanaChainId, intToU8Array32 } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { address, Address, KeyPairSigner } from "@solana/kit";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { arrayify, hexlify } from "ethers/lib/utils";
import {
  SVM_DEFAULT_ADDRESS,
  SvmCpiEventsClient,
  getAssociatedTokenAddress,
  getEventAuthority,
  getFillStatusPda,
  getTimestampForSlot,
} from "../src/arch/svm";
import { RelayData } from "../src/interfaces";
import { SvmAddress, getRelayDataHash } from "../src/utils";
import {
  createDefaultSolanaClient,
  createFill,
  createMint,
  deposit,
  enableRoute,
  generateKeyPairSignerWithSol,
  getRandomSvmAddress,
  initializeSvmSpoke,
  mintTokens,
  requestSlowFill,
} from "./utils/svm/utils";
import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";
import { CHAIN_IDs } from "@across-protocol/constants";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

const formatRelayData = (relayData: SvmSpokeClient.RelayDataArgs): RelayData => {
  return {
    originChainId: Number(relayData.originChainId),
    depositor: SvmAddress.from(relayData.depositor).toBytes32(),
    depositId: BigNumber.from(relayData.depositId),
    recipient: SvmAddress.from(relayData.recipient).toBytes32(),
    inputToken: SvmAddress.from(relayData.inputToken).toBytes32(),
    outputToken: SvmAddress.from(relayData.outputToken).toBytes32(),
    inputAmount: BigNumber.from(relayData.inputAmount),
    outputAmount: BigNumber.from(relayData.outputAmount),
    fillDeadline: relayData.fillDeadline,
    exclusivityDeadline: relayData.exclusivityDeadline,
    message: hexlify(relayData.message),
    exclusiveRelayer: SvmAddress.from(relayData.exclusiveRelayer).toBytes32(),
  };
};

const getRandomInt = (min: number = 0, max: number = 1000000) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

describe("SvmCpiEventsClient (integration)", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;
  // Add chainId property for tests
  solanaClient.chainId = 7777; // Use a test value for Solana testnet
  let client: SvmCpiEventsClient;

  let signer: KeyPairSigner;
  let mint: KeyPairSigner;
  let vault: Address;
  let route: Address;
  let state: Address;
  let eventAuthority: Address;
  let decimals: number;

  const solanaChainId = Number(getSolanaChainId("mainnet"));
  const destinationChainId = 1;
  const tokenAmount = 100000000n;

  // helper to create a deposit
  const sendCreateDeposit = async (payerAta: Address, inputAmount: bigint, outputAmount: bigint) => {
    const latestSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentTime = await solanaClient.rpc.getBlockTime(latestSlot).send();

    const depositInput: SvmSpokeClient.DepositInput = {
      depositor: signer.address,
      recipient: signer.address,
      inputToken: mint.address,
      outputToken: getRandomSvmAddress(),
      inputAmount,
      outputAmount,
      destinationChainId: Number(destinationChainId),
      exclusiveRelayer: signer.address,
      quoteTimestamp: Number(currentTime),
      fillDeadline: Number(currentTime) + 60 * 30, // 30‑minute deadline
      exclusivityParameter: 1,
      message: new Uint8Array(),
      state,
      route,
      depositorTokenAccount: payerAta,
      vault,
      mint: mint.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      eventAuthority,
      signer,
    };

    const signature = await deposit(signer, solanaClient, depositInput, decimals);
    return { signature, depositInput };
  };

  // helper to send a request slow fill
  const sendRequestSlowFill = async (/* add params as needed */) => {
    const latestSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentTime = await getTimestampForSlot(solanaClient.rpc, Number(latestSlot));

    const relayData: SvmSpokeClient.RequestSlowFillInstructionDataArgs["relayData"] = {
      depositor: getRandomSvmAddress(),
      recipient: getRandomSvmAddress(),
      exclusiveRelayer: SVM_DEFAULT_ADDRESS,
      inputToken: getRandomSvmAddress(),
      outputToken: getRandomSvmAddress(),
      inputAmount: getRandomInt(),
      outputAmount: getRandomInt(),
      originChainId: BigInt(destinationChainId),
      depositId: new Uint8Array(intToU8Array32(getRandomInt())),
      fillDeadline: Number(currentTime) + 60 * 30,
      exclusivityDeadline: 0,
      message: new Uint8Array(),
    };
    const formattedRelayData = formatRelayData(relayData);
    const relayDataHash = getRelayDataHash(formattedRelayData, solanaChainId);
    const fillStatusPda = await getFillStatusPda(
      SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      formattedRelayData,
      solanaChainId
    );

    const requestSlowFillInput: SvmSpokeClient.RequestSlowFillInput = {
      program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      relayHash: arrayify(relayDataHash),
      relayData: relayData,
      state,
      fillStatus: fillStatusPda,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      eventAuthority,
      signer,
    };
    const signature = await requestSlowFill(signer, solanaClient, requestSlowFillInput);
    return { signature, relayData };
  };

  // helper to send a fill
  const sendCreateFill = async (/* add params as needed */) => {
    const latestSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentTime = await getTimestampForSlot(solanaClient.rpc, Number(latestSlot));

    const relayData: SvmSpokeClient.FillRelayInput["relayData"] = {
      depositor: getRandomSvmAddress(),
      recipient: getRandomSvmAddress(),
      exclusiveRelayer: SVM_DEFAULT_ADDRESS,
      inputToken: getRandomSvmAddress(),
      outputToken: mint.address,
      inputAmount: getRandomInt(),
      outputAmount: tokenAmount,
      originChainId: BigInt(destinationChainId),
      depositId: new Uint8Array(intToU8Array32(getRandomInt())),
      fillDeadline: Number(currentTime) + 60 * 30,
      exclusivityDeadline: Number(currentTime) + 60 * 30,
      message: new Uint8Array(),
    };

    const formattedRelayData = formatRelayData(relayData);
    const relayDataHash = getRelayDataHash(formattedRelayData, solanaChainId);
    const fillStatusPda = await getFillStatusPda(
      SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      formattedRelayData,
      solanaChainId
    );

    const payerAta = await getAssociatedTokenAddress(
      SvmAddress.from(signer.address),
      SvmAddress.from(mint.address),
      TOKEN_2022_PROGRAM_ADDRESS
    );

    const recipientAta = await getAssociatedTokenAddress(
      SvmAddress.from(relayData.recipient),
      SvmAddress.from(mint.address),
      TOKEN_2022_PROGRAM_ADDRESS
    );

    const fillInput: SvmSpokeClient.FillRelayInput = {
      signer: signer,
      instructionParams: undefined,
      state: state,
      mint: mint.address,
      relayerTokenAccount: payerAta,
      recipientTokenAccount: recipientAta,
      fillStatus: fillStatusPda,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      eventAuthority: eventAuthority,
      program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      relayHash: arrayify(relayDataHash),
      relayData: relayData,
      repaymentChainId: BigInt(destinationChainId),
      repaymentAddress: signer.address,
    };

    const signature = await createFill(signer, solanaClient, fillInput, decimals);
    return { signature, relayData };
  };

  before(async function () {
    /* Local validator spin‑up can take a few seconds */
    this.timeout(60_000);
    await validatorSetup();
    signer = await generateKeyPairSignerWithSol(solanaClient);
    ({ state } = await initializeSvmSpoke(signer, solanaClient, signer.address));
    ({ mint, decimals } = await createMint(signer, solanaClient));
    ({ vault, route } = await enableRoute(signer, solanaClient, BigInt(destinationChainId), state, mint.address));
    client = await SvmCpiEventsClient.create(solanaClient.rpc);
    eventAuthority = await getEventAuthority();
  });

  after(async () => {
    await validatorTeardown();
  });

  it("fetches all events", async () => {
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount * 2n + 1n);
    await sendCreateDeposit(payerAta, tokenAmount, tokenAmount);
    await sendCreateDeposit(payerAta, tokenAmount + 1n, tokenAmount + 1n);

    const allEvents = await client["queryAllEvents"]();

    expect(allEvents.map((e: { name: string }) => e.name)).to.deep.equal([
      "FundsDeposited",
      "FundsDeposited",
      "EnabledDepositRoute",
    ]);
  });

  it("creates and reads a single deposit event", async () => {
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount);
    const { depositInput } = await sendCreateDeposit(payerAta, tokenAmount, tokenAmount);

    const [depositEvent] = await client.queryEvents("FundsDeposited");

    const { data } = depositEvent as { data: SvmSpokeClient.FundsDeposited };

    expect(data.depositor).to.equal(depositInput.depositor.toString());
    expect(data.recipient).to.equal(depositInput.recipient.toString());
    expect(data.inputToken).to.equal(depositInput.inputToken.toString());
    expect(data.outputToken).to.equal(depositInput.outputToken.toString());
    expect(data.inputAmount).to.equal(depositInput.inputAmount);
    expect(data.outputAmount).to.equal(depositInput.outputAmount);
    expect(data.destinationChainId).to.equal(BigInt(depositInput.destinationChainId));
    expect(data.exclusiveRelayer).to.equal(depositInput.exclusiveRelayer.toString());
    expect(data.quoteTimestamp).to.equal(depositInput.quoteTimestamp);
    expect(data.fillDeadline).to.equal(depositInput.fillDeadline);
  });

  it("filters deposit events by slot range", async () => {
    /* First deposit (outside the queried range) */
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount * 2n + 1n);
    const { signature: firstSig } = await sendCreateDeposit(payerAta, tokenAmount, tokenAmount);
    const tx1 = await solanaClient.rpc
      .getTransaction(firstSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx1) throw new Error("first deposit tx not found");

    /* Second deposit (should be returned) */
    const { depositInput: secondDeposit, signature: secondSig } = await sendCreateDeposit(
      payerAta,
      tokenAmount + 1n,
      tokenAmount + 1n
    );
    const tx2 = await solanaClient.rpc
      .getTransaction(secondSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx2) throw new Error("second deposit tx not found");

    const events = (await client.queryEvents(
      "FundsDeposited",
      BigInt(tx1.slot) + 1n, // start *after* first deposit
      BigInt(tx2.slot)
    )) as { data: SvmSpokeClient.FundsDeposited }[];

    expect(events).to.have.lengthOf(1);
    expect(events[0].data.inputAmount).to.equal(secondDeposit.inputAmount);
  });

  it("creates and reads a single request slow fill event", async () => {
    const { relayData } = await sendRequestSlowFill();

    const [requestSlowFillEvent] = await client.queryEvents("RequestedSlowFill");

    const { data } = requestSlowFillEvent as { data: SvmSpokeClient.RequestedSlowFill };

    expect(data.depositor).to.equal(relayData.depositor.toString());
    expect(data.recipient).to.equal(relayData.recipient.toString());
    expect(data.inputToken).to.equal(relayData.inputToken.toString());
    expect(data.outputToken).to.equal(relayData.outputToken.toString());
    expect(data.inputAmount).to.equal(BigInt(relayData.inputAmount));
    expect(data.outputAmount).to.equal(BigInt(relayData.outputAmount));
    expect(data.originChainId).to.equal(BigInt(relayData.originChainId));
    expect(data.depositId.toString()).to.equal(Array.from(relayData.depositId).toString());
    expect(data.fillDeadline).to.equal(relayData.fillDeadline);
    expect(data.exclusivityDeadline).to.equal(relayData.exclusivityDeadline);
  });

  it("creates and reads a single fill event", async () => {
    await mintTokens(signer, solanaClient, mint.address, tokenAmount);
    const { relayData } = await sendCreateFill();

    const [fillEvent] = await client.queryEvents("FilledRelay");

    const { data } = fillEvent as { data: SvmSpokeClient.FilledRelay };

    expect(data.depositor).to.equal(relayData.depositor.toString());
    expect(data.recipient).to.equal(relayData.recipient.toString());
    expect(data.inputToken).to.equal(relayData.inputToken.toString());
    expect(data.outputToken).to.equal(relayData.outputToken.toString());
    expect(data.inputAmount).to.equal(BigInt(relayData.inputAmount));
    expect(data.outputAmount).to.equal(BigInt(relayData.outputAmount));
    expect(data.originChainId).to.equal(BigInt(relayData.originChainId));
    expect(data.depositId.toString()).to.equal(Array.from(relayData.depositId).toString());
    expect(data.fillDeadline).to.equal(relayData.fillDeadline);
    expect(data.exclusivityDeadline).to.equal(relayData.exclusivityDeadline);
  });

  it("gets deposit events from transaction signature", async () => {
    // deposit from solana
    solanaClient.chainId = CHAIN_IDs.SOLANA;
    const payerAta = await mintTokens(signer, solanaClient, address(mint.address), tokenAmount);
    const { depositInput, signature } = await sendCreateDeposit(payerAta, tokenAmount, tokenAmount);

    const depositEvents = await client.getDepositEventsFromSignature(solanaClient.chainId, signature);

    expect(depositEvents).to.have.lengthOf(1);
    const depositEvent = depositEvents![0];
    expect(SvmAddress.from(depositEvent.depositor, "base16").toBase58()).to.equal(depositInput.depositor.toString());
    expect(SvmAddress.from(depositEvent.recipient, "base16").toBase58()).to.equal(depositInput.recipient.toString());
    expect(SvmAddress.from(depositEvent.inputToken, "base16").toBase58()).to.equal(depositInput.inputToken.toString());
    expect(SvmAddress.from(depositEvent.outputToken, "base16").toBase58()).to.equal(
      depositInput.outputToken.toString()
    );
    expect(depositEvent.inputAmount).to.equal(depositInput.inputAmount);
    expect(depositEvent.outputAmount).to.equal(depositInput.outputAmount);
    expect(depositEvent.destinationChainId).to.equal(depositInput.destinationChainId);
  });

  it("gets fill events from transaction signature", async () => {
    // TODO
  });
});
