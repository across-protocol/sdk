import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeaderV2 } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { Address, appendTransactionMessageInstruction, getProgramDerivedAddress, getU64Encoder } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { ethers } from "ethers";
import {
  AttestedCCTPV2Message,
  SVM_SPOKE_SEED,
  finalizeCCTPV2Messages,
  getStatePda,
  hasCCTPV2MessageBeenProcessed,
  getAssociatedTokenAddress,
  createDefaultTransaction,
  getEventAuthority,
} from "../src/arch/svm";
import { SvmAddress } from "../src/utils";
import { signer } from "./Solana.setup";
import {
  createDefaultSolanaClient,
  signAndSendTransaction,
  encodeEmergencyDeleteRootBundleMessageBody,
  encodePauseDepositsMessageBody,
  encodeRelayRootBundleMessageBody,
} from "./utils/svm/utils";
import { TOKEN_SYMBOLS_MAP, CHAIN_IDs } from "../src/constants";

const takeNonce = () => Buffer.from(ethers.utils.randomBytes(32));

interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}
const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;
const USDC = SvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.SOLANA]);

const buildAttestedMessage = async (
  messageBody: Buffer,
  nonce: Buffer,
  sourceDomain = 0,
  destinationDomain = 5,
  messageBytesToHex = true
): Promise<AttestedCCTPV2Message[]> => {
  const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const stateData = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda, { commitment: "confirmed" });

  const messageBytes = encodeMessageHeaderV2({
    version: 1,
    sourceDomain,
    destinationDomain,
    nonce: new BN(nonce),
    minFinalityThreshold: 2000,
    finalityThresholdExecuted: 2000,
    sender: new PublicKey(stateData.data.crossDomainAdmin),
    recipient: new PublicKey(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    destinationCaller: new PublicKey(new Uint8Array(32)),
    messageBody,
  });

  const messageBytesStringPrefix = messageBytesToHex ? "" : "0x";

  return [
    {
      messageBytes: messageBytesStringPrefix + messageBytes.toString("hex"),
      attestation: "0x",
    },
  ];
};

describe("Svm Cctp Messages (integration)", () => {
  const finalize = (msgs: AttestedCCTPV2Message[], recipient: Address, simulate = false) =>
    finalizeCCTPV2Messages(solanaClient.rpc, msgs, signer, { expectedTokenRecipient: recipient, simulate });

  it("pauses and unpauses deposits remotely", async () => {
    const pauseNonce = takeNonce();
    const unpauseNonce = takeNonce();
    const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    const stateAta = await getAssociatedTokenAddress(SvmAddress.from(statePda.toString()), USDC);

    /* ---- pause ---- */
    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, pauseNonce)).to.equal(false);

    let msgs = await buildAttestedMessage(encodePauseDepositsMessageBody(true), pauseNonce);
    await finalize(msgs, stateAta, /* simulate = */ true);
    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, pauseNonce)).to.equal(false);

    await finalize(msgs, stateAta);

    let state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda, { commitment: "confirmed" });
    expect(state.data.pausedDeposits).to.equal(true);
    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, pauseNonce)).to.equal(true);

    /* ---- unpause ---- */
    msgs = await buildAttestedMessage(encodePauseDepositsMessageBody(false), unpauseNonce);
    await finalize(msgs, stateAta);

    state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda, { commitment: "confirmed" });
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
    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, relayNonce)).to.equal(false);

    const relayMsgs = await buildAttestedMessage(
      encodeRelayRootBundleMessageBody(relayerRefundRoot, slowRelayRoot),
      relayNonce,
      0,
      5,
      false
    );

    await finalize(relayMsgs, stateAta, /* simulate = */ true);
    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, relayNonce)).to.equal(false);

    const {
      data: { rootBundleId: beforeRootBundleId },
    } = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda, { commitment: "confirmed" });

    await finalize(relayMsgs, stateAta);

    const {
      data: { rootBundleId: afterRootBundleId },
    } = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda, { commitment: "confirmed" });

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

    await finalize(emergencyMsgs, stateAta);

    expect(await hasCCTPV2MessageBeenProcessed(solanaClient.rpc, emergencyNonce)).to.equal(true);

    const bundleAccountInfo = await solanaClient.rpc.getAccountInfo(rootBundlePda, { commitment: "confirmed" }).send();
    expect(bundleAccountInfo.value).to.equal(null);
    expect(await finalize(emergencyMsgs, stateAta)).to.deep.equal([null]);
  });
  it("pauses and unpauses fills in order", async () => {
    const iface = new ethers.utils.Interface(["function pauseFills(bool)"]);
    const pause = await buildAttestedMessage(
      Buffer.from(ethers.utils.arrayify(iface.encodeFunctionData("pauseFills", [true]))),
      takeNonce()
    );
    const unpause = await buildAttestedMessage(
      Buffer.from(ethers.utils.arrayify(iface.encodeFunctionData("pauseFills", [false]))),
      takeNonce()
    );
    await finalizeCCTPV2Messages(solanaClient.rpc, [...pause, ...unpause], signer);
    const state = await SvmSpokeClient.fetchState(
      solanaClient.rpc,
      await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
      { commitment: "confirmed" }
    );
    expect(state.data.pausedFills).to.equal(false);
  });

  it("changes the remote admin and can replay the old message after the change", async () => {
    const iface = new ethers.utils.Interface(["function setCrossDomainAdmin(address)"]);
    const newAdmin = "0x0000000000000000000000000000000000000123";
    const msgs = await buildAttestedMessage(
      Buffer.from(ethers.utils.arrayify(iface.encodeFunctionData("setCrossDomainAdmin", [newAdmin]))),
      takeNonce()
    );
    await finalizeCCTPV2Messages(solanaClient.rpc, msgs, signer);
    expect(await finalizeCCTPV2Messages(solanaClient.rpc, msgs, signer)).to.deep.equal([null]);
    const state = await SvmSpokeClient.fetchState(
      solanaClient.rpc,
      await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
      { commitment: "confirmed" }
    );
    expect(state.data.crossDomainAdmin).to.equal(
      new PublicKey(ethers.utils.arrayify(ethers.utils.hexZeroPad(newAdmin, 32))).toBase58()
    );
    const program = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;
    const restoreAdmin = SvmSpokeClient.getSetCrossDomainAdminInstruction({
      signer,
      state: await getStatePda(program),
      crossDomainAdmin: signer.address,
      eventAuthority: await getEventAuthority(program),
      program,
    });
    await signAndSendTransaction(
      solanaClient,
      appendTransactionMessageInstruction(restoreAdmin, await createDefaultTransaction(solanaClient.rpc, signer))
    );
  });
});
