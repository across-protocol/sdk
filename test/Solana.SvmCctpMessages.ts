import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeader } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { getProgramDerivedAddress, getU64Encoder, signature } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { ethers } from "ethers";
import {
  AttestedCCTPMessage,
  SVM_SPOKE_SEED,
  finalizeCCTPV1Messages,
  getStatePda,
  hasCCTPV1MessageBeenProcessed,
  getAssociatedTokenAddress,
} from "../src/arch/svm";
import { SvmAddress } from "../src/utils";
import { signer } from "./Solana.setup";
import {
  createDefaultSolanaClient,
  encodeEmergencyDeleteRootBundleMessageBody,
  encodePauseDepositsMessageBody,
  encodeRelayRootBundleMessageBody,
} from "./utils/svm/utils";
import { TOKEN_SYMBOLS_MAP, CHAIN_IDs } from "../src/constants";

let nextCctpNonce = 1;
const takeNonce = () => nextCctpNonce++;

interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}
const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;
const USDC = SvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SOLANA]);

const buildAttestedMessage = async (
  messageBody: Buffer,
  nonce: number,
  sourceDomain = 0,
  destinationDomain = 5,
  messageBytesToHex = true
): Promise<AttestedCCTPMessage[]> => {
  const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const stateData = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

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

  const messageBytesStringPrefix = messageBytesToHex ? "" : "0x";

  return [
    {
      sourceDomain,
      messageBytes: messageBytesStringPrefix + messageBytes.toString("hex"),
      attestation: "0x",
      nonce,
      type: "message",
    },
  ];
};

describe("Svm Cctp Messages (integration)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const finalize = (msgs: AttestedCCTPMessage[], recipient: SvmAddress, simulate = false) =>
    finalizeCCTPV1Messages(solanaClient.rpc, msgs, signer, recipient, simulate, 0);
  const sendAndConfirm = async (sigs: string[]) => {
    await solanaClient.rpc
      .getTransaction(signature(sigs[0]), {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    await wait(1_000); // give the chain time to settle
  };

  it("pauses and unpauses deposits remotely", async () => {
    const pauseNonce = takeNonce();
    const unpauseNonce = takeNonce(); // next nonce in sequence
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    const stateAta = await getAssociatedTokenAddress(SvmAddress.from(statePda.toString()), USDC);

    /* ---- pause ---- */
    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, pauseNonce, 0)).to.equal(false);

    let msgs = await buildAttestedMessage(encodePauseDepositsMessageBody(true), pauseNonce);
    await finalize(msgs, stateAta, /* simulate = */ true);
    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, pauseNonce, 0)).to.equal(false);

    await sendAndConfirm(await finalize(msgs, stateAta));

    let state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);
    expect(state.data.pausedDeposits).to.equal(true);
    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, pauseNonce, 0)).to.equal(true);

    /* ---- unpause ---- */
    msgs = await buildAttestedMessage(encodePauseDepositsMessageBody(false), unpauseNonce);
    await sendAndConfirm(await finalize(msgs, stateAta));

    state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);
    expect(state.data.pausedDeposits).to.equal(false);
  });

  it("relays a root bundle and emergency deletes it", async () => {
    const relayNonce = takeNonce();
    const emergencyNonce = takeNonce();
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    const stateAta = await getAssociatedTokenAddress(SvmAddress.from(statePda.toString()), USDC);

    const relayerRefundRoot = ethers.utils.formatBytes32String("relayerRefundRoot");
    const slowRelayRoot = ethers.utils.formatBytes32String("slowRelayRoot");

    /* ---- relay root bundle ---- */
    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, relayNonce, 0)).to.equal(false);

    const relayMsgs = await buildAttestedMessage(
      encodeRelayRootBundleMessageBody(relayerRefundRoot, slowRelayRoot),
      relayNonce,
      0,
      5,
      false
    );

    await finalize(relayMsgs, stateAta, /* simulate = */ true);
    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, relayNonce, 0)).to.equal(false);

    const {
      data: { rootBundleId: beforeRootBundleId },
    } = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    await sendAndConfirm(await finalize(relayMsgs, stateAta));

    const {
      data: { rootBundleId: afterRootBundleId },
    } = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(afterRootBundleId).to.equal(beforeRootBundleId + 1);

    /* ---- emergency delete root bundle ---- */
    const intEncoder = getU64Encoder();
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(beforeRootBundleId);

    const [rootBundlePda] = await getProgramDerivedAddress({
      programAddress: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      seeds: ["root_bundle", intEncoder.encode(SVM_SPOKE_SEED), idBuf],
    });

    const emergencyMsgs = await buildAttestedMessage(
      encodeEmergencyDeleteRootBundleMessageBody(beforeRootBundleId),
      emergencyNonce,
      0,
      5,
      false
    );

    await sendAndConfirm(await finalize(emergencyMsgs, stateAta));

    expect(await hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, emergencyNonce, 0)).to.equal(true);

    const bundleAccountInfo = await solanaClient.rpc.getAccountInfo(rootBundlePda).send();
    expect(bundleAccountInfo.value).to.equal(null);
  });
});
