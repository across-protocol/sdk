import { SvmSpokeClient } from "@across-protocol/contracts";
import { getSolanaChainId } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { Address, KeyPairSigner } from "@solana/kit";
import { expect } from "chai";
import { BigNumber } from "ethers";
import {
  SvmCpiEventsClient,
  _calculateRelayHashUint8Array,
  getEventAuthority,
  getFillStatusPda2,
  getTimestampForSlot,
} from "../src/arch/svm";
import {
  createDefaultSolanaClient,
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

describe.only("SvmCpiEventsClient (integration)", () => {
  const solanaClient = createDefaultSolanaClient();
  let client: SvmCpiEventsClient;

  let signer: KeyPairSigner;
  let mint: KeyPairSigner;
  let vault: Address;
  let route: Address;
  let state: Address;
  let decimals: number;

  const destinationChainId = 1n;
  const tokenAmount = 100000000n;

  // helper to create a deposit
  const createDeposit = async (payerAta: Address, inputAmount: bigint, outputAmount: bigint) => {
    const latestSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentTime = await solanaClient.rpc.getBlockTime(latestSlot).send();
    const eventAuthority = await getEventAuthority();

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
  const uint8ArrayToBigNumber = (arr: Uint8Array): BigNumber => {
    if (arr.length === 0) {
      return BigNumber.from(0); // or handle this case appropriately
    }

    const hex = Array.from(arr)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return BigNumber.from("0x" + hex);
  };

  const sendRequestSlowFill = async () => {
    const eventAuthority = await getEventAuthority();

    const latestSlot = await solanaClient.rpc.getSlot({ commitment: "confirmed" }).send();
    const currentTime = await getTimestampForSlot(solanaClient.rpc, Number(latestSlot));

    const relayData: SvmSpokeClient.RequestSlowFillInstructionDataArgs["relayData"] = {
      depositor: signer.address,
      recipient: signer.address,
      exclusiveRelayer: signer.address,
      inputToken: mint.address,
      outputToken: getRandomSvmAddress(),
      inputAmount: tokenAmount,
      outputAmount: tokenAmount,
      originChainId: 1,
      depositId: new Uint8Array(),
      fillDeadline: Number(currentTime) + 60 * 30, // 30‑minute deadline
      exclusivityDeadline: Number(currentTime) + 60 * 30, // 30‑minute deadline
      message: new Uint8Array([1, 2, 3]),
    };

    // const formattedRelayData: RelayData = {
    //   originChainId: Number(destinationChainId),
    //   depositor: SvmAddress.from(relayData.depositor).toBytes32(),
    //   depositId: uint8ArrayToBigNumber(new Uint8Array(relayData.depositId)),
    //   recipient: SvmAddress.from(relayData.recipient).toBytes32(),
    //   inputToken: SvmAddress.from(relayData.inputToken).toBytes32(),
    //   outputToken: SvmAddress.from(relayData.outputToken).toBytes32(),
    //   inputAmount: BigNumber.from(relayData.inputAmount),
    //   outputAmount: BigNumber.from(relayData.outputAmount),
    //   fillDeadline: relayData.fillDeadline,
    //   exclusivityDeadline: relayData.exclusivityDeadline,
    //   message: relayData.message.toString(),
    //   exclusiveRelayer: SvmAddress.from(relayData.exclusiveRelayer).toBytes32(),
    // };

    // const fillStatusPda = await getFillStatusPda(
    //   SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    //   formattedRelayData,
    //   Number(getSolanaChainId("mainnet").toString())
    // );

    const chainId = getSolanaChainId("mainnet");

    const relayDataHash = _calculateRelayHashUint8Array(relayData, BigInt(chainId.toString()));

    const fillStatusPda2 = await getFillStatusPda2(
      SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      relayData,
      Number(chainId.toString())
    );

    const requestSlowFillInput: SvmSpokeClient.RequestSlowFillInput = {
      program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      relayHash: relayDataHash,
      relayData: relayData,
      state,
      fillStatus: fillStatusPda2,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      eventAuthority,
      signer,
    };
    return requestSlowFill(signer, solanaClient, requestSlowFillInput);
  };

  before(async function () {
    /* Local validator spin‑up can take a few seconds */
    this.timeout(60_000);
    await validatorSetup();
    signer = await generateKeyPairSignerWithSol(solanaClient);
    ({ state } = await initializeSvmSpoke(signer, solanaClient, signer.address));
    ({ mint, decimals } = await createMint(signer, solanaClient));
    ({ vault, route } = await enableRoute(signer, solanaClient, destinationChainId, state, mint.address));
    client = await SvmCpiEventsClient.create(solanaClient.rpc);
  });

  after(async () => {
    await validatorTeardown();
  });

  it("fetches all events", async () => {
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount * 2n + 1n);
    await createDeposit(payerAta, tokenAmount, tokenAmount);
    await createDeposit(payerAta, tokenAmount + 1n, tokenAmount + 1n);

    const allEvents = await client["queryAllEvents"]();

    expect(allEvents.map((e: { name: string }) => e.name)).to.deep.equal([
      "FundsDeposited",
      "FundsDeposited",
      "EnabledDepositRoute",
    ]);
  });

  it("creates and reads a single deposit event", async () => {
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount);
    const { depositInput } = await createDeposit(payerAta, tokenAmount, tokenAmount);

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
    const { signature: firstSig } = await createDeposit(payerAta, tokenAmount, tokenAmount);
    const tx1 = await solanaClient.rpc
      .getTransaction(firstSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx1) throw new Error("first deposit tx not found");

    /* Second deposit (should be returned) */
    const { depositInput: secondDeposit, signature: secondSig } = await createDeposit(
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

  it.only("creates and reads a single request slow fill event", async () => {
    await sendRequestSlowFill();

    const [requestSlowFillEvent] = await client.queryEvents("RequestedSlowFill");

    const { data } = requestSlowFillEvent as { data: SvmSpokeClient.RequestedSlowFill };

    expect(data.depositor).to.equal(signer.address.toString());
    expect(data.recipient).to.equal(signer.address.toString());
    expect(data.inputToken).to.equal(mint.address.toString());
  });
});
