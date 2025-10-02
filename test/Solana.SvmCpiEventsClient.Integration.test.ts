import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { u8Array32ToInt } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { KeyPairSigner, address } from "@solana/kit";
import { expect } from "chai";
import { SvmCpiEventsClient, bigToU8a32 } from "../src/arch/svm";
import { signer } from "./Solana.setup";
import {
  createDefaultSolanaClient,
  createMint,
  mintTokens,
  sendCreateDeposit,
  sendCreateFill,
  sendRequestSlowFill,
} from "./utils/svm/utils";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

describe("SvmCpiEventsClient (integration)", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;
  // Add chainId property for tests
  solanaClient.chainId = 7777; // Use a test value for Solana testnet
  let client: SvmCpiEventsClient;

  let mint: KeyPairSigner;
  let decimals: number;

  const tokenAmount = 100000000n;

  before(async function () {
    ({ mint, decimals } = await createMint(signer, solanaClient));
    client = await SvmCpiEventsClient.create(solanaClient.rpc);
  });

  it("fetches all events", async () => {
    // Store initial slot
    const fromSlot = await solanaClient.rpc.getSlot().send();
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount * 2n + 1n);
    await sendCreateDeposit(solanaClient, signer, mint, decimals, payerAta, {
      inputAmount: tokenAmount,
      outputAmount: bigToU8a32(tokenAmount),
    });
    await sendCreateDeposit(solanaClient, signer, mint, decimals, payerAta, {
      inputAmount: tokenAmount + 1n,
      outputAmount: bigToU8a32(tokenAmount + 1n),
    });
    // Store final slot
    const toSlot = await solanaClient.rpc.getSlot().send();

    // Query events from initial to final slot
    const allEvents = await client["queryAllEvents"](fromSlot, toSlot);

    expect(allEvents.map((e: { name: string }) => e.name)).to.deep.equal(["FundsDeposited", "FundsDeposited"]);
  });

  it("creates and reads a single deposit event", async () => {
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount);
    const { depositInput } = await sendCreateDeposit(solanaClient, signer, mint, decimals, payerAta, {
      inputAmount: tokenAmount,
      outputAmount: bigToU8a32(tokenAmount),
      message: Buffer.from([48, 120]),
    });

    const [depositEvent] = await client.queryEvents("FundsDeposited");

    const { data } = depositEvent as { data: SvmSpokeClient.FundsDeposited };

    expect(data.depositor).to.equal(depositInput.depositor.toString());
    expect(data.recipient).to.equal(depositInput.recipient.toString());
    expect(data.inputToken).to.equal(depositInput.inputToken.toString());
    expect(data.outputToken).to.equal(depositInput.outputToken.toString());
    expect(data.inputAmount).to.equal(depositInput.inputAmount);
    expect(u8Array32ToInt(Array.from(data.outputAmount))).to.equal(
      u8Array32ToInt(Array.from(depositInput.outputAmount))
    );
    expect(data.destinationChainId).to.equal(BigInt(depositInput.destinationChainId));
    expect(data.exclusiveRelayer).to.equal(depositInput.exclusiveRelayer.toString());
    expect(data.quoteTimestamp).to.equal(depositInput.quoteTimestamp);
    expect(data.fillDeadline).to.equal(depositInput.fillDeadline);
    expect(Buffer.from(data.message).toString()).to.equal(depositInput.message.toString());
  });

  it("filters deposit events by slot range", async () => {
    /* First deposit (outside the queried range) */
    const payerAta = await mintTokens(signer, solanaClient, mint.address, tokenAmount * 2n + 1n);
    const { signature: firstSig } = await sendCreateDeposit(solanaClient, signer, mint, decimals, payerAta, {
      inputAmount: tokenAmount,
      outputAmount: bigToU8a32(tokenAmount),
    });
    const tx1 = await solanaClient.rpc
      .getTransaction(firstSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx1) throw new Error("first deposit tx not found");

    /* Second deposit (should be returned) */
    const { depositInput: secondDeposit, signature: secondSig } = await sendCreateDeposit(
      solanaClient,
      signer,
      mint,
      decimals,
      payerAta,
      { inputAmount: tokenAmount + 1n, outputAmount: bigToU8a32(tokenAmount + 1n) }
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
    const { relayData } = await sendRequestSlowFill(solanaClient, signer);

    const [requestSlowFillEvent] = await client.queryEvents("RequestedSlowFill");

    const { data } = requestSlowFillEvent as { data: SvmSpokeClient.RequestedSlowFill };

    expect(data.depositor).to.equal(relayData.depositor);
    expect(data.recipient).to.equal(relayData.recipient);
    expect(data.inputToken).to.equal(relayData.inputToken);
    expect(data.outputToken).to.equal(relayData.outputToken);
    expect(u8Array32ToInt(Array.from(data.inputAmount))).to.equal(u8Array32ToInt(Array.from(relayData.inputAmount)));
    expect(data.outputAmount).to.equal(BigInt(relayData.outputAmount));
    expect(data.originChainId).to.equal(BigInt(relayData.originChainId));
    expect(data.depositId.toString()).to.equal(Array.from(relayData.depositId).toString());
    expect(data.fillDeadline).to.equal(relayData.fillDeadline);
    expect(data.exclusivityDeadline).to.equal(relayData.exclusivityDeadline);
  });

  it("creates and reads a single fill event", async () => {
    await mintTokens(signer, solanaClient, mint.address, tokenAmount);
    const { relayData } = await sendCreateFill(solanaClient, signer, mint, decimals, true);
    const [fillEvent] = await client.queryEvents("FilledRelay");

    const { data } = fillEvent as { data: SvmSpokeClient.FilledRelay };

    expect(data.depositor).to.equal(relayData.depositor);
    expect(data.recipient).to.equal(relayData.recipient);
    expect(data.inputToken).to.equal(relayData.inputToken);
    expect(data.outputToken).to.equal(relayData.outputToken);
    expect(u8Array32ToInt(Array.from(data.inputAmount))).to.equal(u8Array32ToInt(Array.from(relayData.inputAmount)));
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
    const { depositInput, signature } = await sendCreateDeposit(solanaClient, signer, mint, decimals, payerAta, {
      inputAmount: tokenAmount,
      outputAmount: bigToU8a32(tokenAmount),
    });

    const depositEvents = await client.getDepositEventsFromSignature(solanaClient.chainId, signature);

    expect(depositEvents).to.have.lengthOf(1);
    const depositEvent = depositEvents![0];
    expect(depositEvent.depositor.toBase58()).to.equal(depositInput.depositor.toString());
    expect(depositEvent.recipient.toBase58()).to.equal(depositInput.recipient.toString());
    expect(depositEvent.inputToken.toBase58()).to.equal(depositInput.inputToken.toString());
    expect(depositEvent.outputToken.toBase58()).to.equal(depositInput.outputToken.toString());
    expect(depositEvent.inputAmount.toString()).to.equal(depositInput.inputAmount.toString());
    expect(BigInt(depositEvent.outputAmount.toString())).to.equal(
      BigInt(u8Array32ToInt(Array.from(depositInput.outputAmount)))
    );
    expect(depositEvent.destinationChainId).to.equal(depositInput.destinationChainId);
  });

  it("gets fill events from transaction signature", async () => {
    solanaClient.chainId = CHAIN_IDs.SOLANA;

    await mintTokens(signer, solanaClient, address(mint.address), tokenAmount);

    const { relayData, signature } = await sendCreateFill(solanaClient, signer, mint, decimals);

    const fillEvents = await client.getFillEventsFromSignature(solanaClient.chainId, signature);

    expect(fillEvents).to.have.lengthOf(1);
    const fillEvent = fillEvents![0];

    expect(fillEvent.depositor.toBase58()).to.equal(relayData.depositor);
    expect(fillEvent.recipient.toBase58()).to.equal(relayData.recipient);
    expect(fillEvent.inputToken.toBase58()).to.equal(relayData.inputToken);
    expect(fillEvent.outputToken.toBase58()).to.equal(relayData.outputToken);
    expect(BigInt(fillEvent.inputAmount.toString())).to.equal(
      BigInt(u8Array32ToInt(Array.from(relayData.inputAmount)))
    );
    expect(fillEvent.outputAmount.toString()).to.equal(BigInt(relayData.outputAmount).toString());
    expect(fillEvent.originChainId).to.equal(Number(relayData.originChainId));
    expect(fillEvent.depositId).to.equal(u8Array32ToInt(Array.from(relayData.depositId)));
    expect(fillEvent.fillDeadline).to.equal(Number(relayData.fillDeadline));
    expect(fillEvent.exclusivityDeadline).to.equal(Number(relayData.exclusivityDeadline));
  });
});
