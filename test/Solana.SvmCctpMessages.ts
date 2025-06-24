import { SvmSpokeClient } from "@across-protocol/contracts";
import { expect } from "chai";
import { getStatePda } from "../src/arch/svm";
import { signer } from "./Solana.setup";
import { createDefaultSolanaClient, encodePauseDepositsMessageBody, sendReceiveCctpMessage } from "./utils/svm/utils";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

describe("Svm Cctp Messages (integration)", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;

  it("pauses and unpauses deposits remotely", async () => {
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);

    // pause deposits
    await sendReceiveCctpMessage({
      solanaClient,
      signer,
      messageBody: encodePauseDepositsMessageBody(true),
      nonce: 1n,
    });

    let state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(true);

    // unpause deposits
    await sendReceiveCctpMessage({
      solanaClient,
      signer,
      messageBody: encodePauseDepositsMessageBody(false),
      nonce: 2n,
    });

    state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(false);
  });
});
