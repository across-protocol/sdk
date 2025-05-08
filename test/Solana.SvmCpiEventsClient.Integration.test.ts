import { SvmSpokeClient } from "@across-protocol/contracts";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { Address, KeyPairSigner } from "@solana/kit";
import { expect } from "chai";
import { SvmCpiEventsClient } from "../src/arch/svm";
import {
  createDefaultSolanaClient,
  createMint,
  deposit,
  enableRoute,
  generateKeyPairSignerWithSol,
  getRandomSvmAddress,
  initializeSvmSpoke,
  mintTokens,
} from "./utils/svm/utils";
import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";

describe("SvmCpiEventsClient (integration)", () => {
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

    const depositData = {
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
    };

    const depositAccounts = {
      state,
      route,
      signer: signer.address,
      depositorTokenAccount: payerAta,
      vault,
      mint: mint.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    };

    const signature = await deposit(signer, depositData, depositAccounts, decimals, solanaClient);
    return { signature, depositData };
  };

  before(async function () {
    /* Local validator spin‑up can take a few seconds */
    this.timeout(30_000);
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
    const { depositData } = await createDeposit(payerAta, tokenAmount, tokenAmount);

    const [depositEvent] = await client.queryEvents("FundsDeposited");

    const { data } = depositEvent as { data: SvmSpokeClient.FundsDeposited };

    expect(data.depositor).to.equal(depositData.depositor.toString());
    expect(data.recipient).to.equal(depositData.recipient.toString());
    expect(data.inputToken).to.equal(depositData.inputToken.toString());
    expect(data.outputToken).to.equal(depositData.outputToken.toString());
    expect(data.inputAmount).to.equal(depositData.inputAmount);
    expect(data.outputAmount).to.equal(depositData.outputAmount);
    expect(data.destinationChainId).to.equal(BigInt(depositData.destinationChainId));
    expect(data.exclusiveRelayer).to.equal(depositData.exclusiveRelayer.toString());
    expect(data.quoteTimestamp).to.equal(depositData.quoteTimestamp);
    expect(data.fillDeadline).to.equal(depositData.fillDeadline);
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
    const { depositData: secondDeposit, signature: secondSig } = await createDeposit(
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
});
