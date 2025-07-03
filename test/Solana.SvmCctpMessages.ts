import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeader } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { signature } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  AttestedCCTPMessage,
  finalizeCCTPV1Messages,
  getStatePda,
  hasCCTPV1MessageBeenProcessed,
} from "../src/arch/svm";
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
        sourceDomain,
        messageBytes: messageBytes.toString("hex"),
        attestation: "0x",
        nonce,
        type: "message",
      } as AttestedCCTPMessage,
    ];
  };

  it("pauses and unpauses deposits remotely", async () => {
    const firstNonce = 1;
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);

    let isNonceUsed = await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(false);

    let attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), firstNonce, 0, 5);

    // simulate the transaction
    await finalizeCCTPV1Messages(solanaClient.rpc, attestedMessages, signer, true, 0);

    isNonceUsed = await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(false);
    // pause deposits
    let signatures = await finalizeCCTPV1Messages(solanaClient.rpc, attestedMessages, signer, false, 0);
    await solanaClient.rpc
      .getTransaction(signature(signatures[0]), {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      })
      .send();

    await new Promise((resolve) => setTimeout(resolve, 500));

    let state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(true);

    isNonceUsed = await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, firstNonce, 0);

    expect(isNonceUsed).to.equal(true);

    attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(false), firstNonce + 1, 0, 5);

    // unpause deposits
    signatures = await finalizeCCTPV1Messages(solanaClient.rpc, attestedMessages, signer, false, 0);
    await solanaClient.rpc
      .getTransaction(signature(signatures[0]), {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    await new Promise((resolve) => setTimeout(resolve, 500));

    state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(false);
  });
});
