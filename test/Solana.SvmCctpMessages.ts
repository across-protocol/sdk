import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeader } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { AttestedCCTPMessage, finalizeSvmMessages, getStatePda, hasCCTPMessageBeenProcessed } from "../src/arch/svm";
import { signer } from "./Solana.setup";
import { createDefaultSolanaClient, encodePauseDepositsMessageBody } from "./utils/svm/utils";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

describe("Svm Cctp Messages (integration)", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;

  const getAttestedMessage = async (
    messageBody: Buffer,
    nonce: number,
    sourceDomain: number = 0,
    destinationDomain: number = 5
  ) => {
    const stateData = await SvmSpokeClient.fetchState(
      solanaClient.rpc,
      await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS)
    );
    const messageBytes = encodeMessageHeader({
      version: 0,
      sourceDomain,
      destinationDomain,
      nonce: BigInt(nonce),
      sender: new PublicKey(stateData.data.crossDomainAdmin),
      recipient: new PublicKey(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
      destinationCaller: new PublicKey(new Uint8Array(32)),
      messageBody,
    });

    return [
      {
        destinationDomain,
        sourceDomain,
        messageBytes: messageBytes.toString("hex"),
        attestation: "0x",
        nonce,
        cctpVersion: 0,
        sender: "0x",
        recipient: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
        messageHash: "0x",
        nonceHash: "",
        status: "ready",
        log: {
          blockNumber: 0,
          blockHash: "0x",
          transactionIndex: 0,
          removed: false,
          logIndex: 0,
          transactionHash: "0x",
          address: "0x",
          data: "0x",
          topics: ["0x"],
          event: "TEST",
          args: {
            test: true,
          },
        },
      } as AttestedCCTPMessage,
    ];
  };

  it("pauses and unpauses deposits remotely", async () => {
    const firstNonce = 1;
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);

    let isNonceUsed = await hasCCTPMessageBeenProcessed(solanaClient, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(false);

    let attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), firstNonce, 0, 5);

    // simulate the transaction
    await finalizeSvmMessages(attestedMessages, signer, true, 0, solanaClient);

    isNonceUsed = await hasCCTPMessageBeenProcessed(solanaClient, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(false);

    await finalizeSvmMessages(attestedMessages, signer, false, 0, solanaClient);

    let state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(true);

    isNonceUsed = await hasCCTPMessageBeenProcessed(solanaClient, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(true);

    attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(false), firstNonce + 1, 0, 5);

    // unpause deposits
    await finalizeSvmMessages(attestedMessages, signer, false, 0, solanaClient);

    state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(false);
  });
});
