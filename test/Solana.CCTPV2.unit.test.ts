import { MessageTransmitterV2Client, SvmSpokeClient, TokenMessengerMinterV2Client } from "@across-protocol/contracts";
import {
  AccountRole,
  Address,
  ReadonlyUint8Array,
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { expect } from "chai";
import assert from "assert";
import { ethers } from "ethers";
import sinon from "sinon";
import {
  SVMProvider,
  SVMEventNames,
  SvmSpokeEventsIdl,
  decodeEvent,
  decodeCCTPV2Message,
  decodeCCTPV2BurnMessage,
  getCCTPNoncePda,
  hasCCTPV2MessageBeenProcessed,
  getCCTPV2ReceiveMessageTx,
  getAccountMetasForTokenlessMessage,
  getAccountMetasForCCTPV2TokenMessage,
  fetchCCTPV2Messages,
  finalizeCCTPV2Messages,
  getStatePda,
  getRootBundlePda,
  getAssociatedTokenAddress,
} from "../src/arch/svm";
import { SvmAddress } from "../src/utils";

const spoke = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS;
const messenger = TokenMessengerMinterV2Client.TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS;
const transmitter = MessageTransmitterV2Client.MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS;
const encoder = getAddressEncoder();
const admin = address("11111111111111111111111111111112");
const nonce = Buffer.from(ethers.utils.randomBytes(32));
const abi = new ethers.utils.Interface([
  "function pauseDeposits(bool)",
  "function pauseFills(bool)",
  "function setCrossDomainAdmin(address)",
  "function relayRootBundle(bytes32,bytes32)",
  "function emergencyDeleteRootBundle(uint256)",
]);
const defaultBody = Buffer.from(ethers.utils.arrayify(abi.encodeFunctionData("pauseDeposits", [true])));

function message(
  body = defaultBody,
  overrides: {
    recipient?: Address;
    sender?: Address;
    caller?: Address;
    sourceDomain?: number;
    destinationDomain?: number;
    finality?: number;
    nonce?: Buffer;
  } = {}
) {
  const header = Buffer.alloc(148);
  header.writeUInt32BE(1);
  header.writeUInt32BE(overrides.sourceDomain ?? 0, 4);
  header.writeUInt32BE(overrides.destinationDomain ?? 5, 8);
  (overrides.nonce ?? nonce).copy(header, 12);
  header.set(encoder.encode(overrides.sender ?? admin), 44);
  header.set(encoder.encode(overrides.recipient ?? spoke), 76);
  header.set(encoder.encode(overrides.caller ?? SYSTEM_PROGRAM_ADDRESS), 108);
  header.writeUInt32BE(1000, 140);
  header.writeUInt32BE(overrides.finality ?? 2000, 144);
  return { messageBytes: ethers.utils.hexlify(Buffer.concat([header, body])), attestation: "0x01" };
}

function account(data: ReadonlyUint8Array, owner: Address) {
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    owner,
    lamports: 1_000_000n,
    executable: false,
    space: BigInt(data.length),
  };
}

function rpcWithAccounts(accounts: Map<Address, ReturnType<typeof account>>) {
  const getAccountInfo = sinon
    .stub()
    .callsFake((key: Address) => ({ send: () => Promise.resolve({ value: accounts.get(key) ?? null }) }));
  const getLatestBlockhash = () => ({
    send: () => Promise.resolve({ value: { blockhash: SYSTEM_PROGRAM_ADDRESS, lastValidBlockHeight: 100n } }),
  });
  return { rpc: { getAccountInfo, getLatestBlockhash } as unknown as SVMProvider, getAccountInfo };
}

describe("SVM CCTP V2", () => {
  afterEach(() => sinon.restore());

  it("decodes the attested header and derives the full 32-byte used_nonce PDA locally", async () => {
    const header = decodeCCTPV2Message(message().messageBytes);
    expect(header.nonce).to.deep.equal(nonce);
    expect(header.sender).to.equal(admin);
    expect(header.finalityThresholdExecuted).to.equal(2000);
    const [expected] = await getProgramDerivedAddress({ programAddress: transmitter, seeds: ["used_nonce", nonce] });
    expect(await getCCTPNoncePda(nonce)).to.equal(expected);
    const otherNonce = Buffer.from(nonce);
    otherNonce[0] ^= 1;
    expect(await getCCTPNoncePda(otherNonce)).not.to.equal(expected);
    await assert.rejects(getCCTPNoncePda("0x01"), /32 bytes/);
    expect(() => decodeCCTPV2Message("0xzz")).to.throw("Invalid CCTP hex");
    expect(() => decodeCCTPV2Message(Buffer.alloc(116))).to.throw("header");
    expect(() => decodeCCTPV2Message(Buffer.alloc(148))).to.throw("wire version 1");
  });

  it("checks absent, unused and used nonce accounts without a signer or simulation", async () => {
    const accounts = new Map<Address, ReturnType<typeof account>>();
    const { rpc } = rpcWithAccounts(accounts);
    const pda = await getCCTPNoncePda(nonce);
    expect(await hasCCTPV2MessageBeenProcessed(rpc, nonce)).to.equal(false);
    for (const isUsed of [false, true]) {
      accounts.set(pda, account(MessageTransmitterV2Client.getUsedNonceEncoder().encode({ isUsed }), transmitter));
      expect(await hasCCTPV2MessageBeenProcessed(rpc, nonce)).to.equal(isUsed);
    }
  });

  async function spokeFixture() {
    const signer = await generateKeyPairSigner();
    const state = await getStatePda(spoke);
    const accounts = new Map([
      [
        state,
        account(
          SvmSpokeClient.getStateEncoder().encode({
            pausedDeposits: false,
            pausedFills: false,
            owner: signer.address,
            seed: 0n,
            numberOfDeposits: 0,
            chainId: 34268394551451n,
            currentTime: 0,
            remoteDomain: 0,
            crossDomainAdmin: admin,
            rootBundleId: 7,
            depositQuoteTimeBuffer: 3600,
            fillDeadlineBuffer: 3600,
          }),
          spoke
        ),
      ],
    ]);
    return { ...rpcWithAccounts(accounts), signer, state, accounts };
  }

  for (const [name, args] of [
    ["pauseDeposits", [true]],
    ["pauseFills", [false]],
    ["setCrossDomainAdmin", ["0x0000000000000000000000000000000000000123"]],
    ["relayRootBundle", [ethers.constants.HashZero, ethers.constants.HashZero]],
    ["emergencyDeleteRootBundle", [3]],
  ] as const) {
    it(`builds authenticated ${name} accounts`, async () => {
      const { rpc, signer, state } = await spokeFixture();
      const msg = message(Buffer.from(ethers.utils.arrayify(abi.encodeFunctionData(name, [...args]))));
      const metas = await getAccountMetasForTokenlessMessage(rpc, signer, msg.messageBytes);
      expect(metas[0]).to.deep.equal({ address: state, role: AccountRole.READONLY });
      if (name === "relayRootBundle" || name === "emergencyDeleteRootBundle") {
        expect(metas[3].address).to.equal(signer.address);
        expect(metas[3].role).to.equal(name === "relayRootBundle" ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE);
        expect(metas[5]).to.deep.equal({
          address: await getRootBundlePda(spoke, name === "relayRootBundle" ? 7 : 3),
          role: AccountRole.WRITABLE,
        });
      } else {
        expect(metas[3]).to.deep.equal({ address: state, role: AccountRole.WRITABLE });
      }
      const tx = await getCCTPV2ReceiveMessageTx(rpc, signer, msg);
      expect(tx.instructions[0].programAddress).to.equal(transmitter);
      expect(tx.instructions[0].accounts?.[4].address).to.equal(await getCCTPNoncePda(nonce));
    });
  }

  it("rejects wrong domains/admin/caller/receiver, low Spoke finality and unsupported selectors", async () => {
    const { rpc, signer } = await spokeFixture();
    for (const [overrides, error] of [
      [{ sourceDomain: 1 }, /remote domain and admin/],
      [{ sender: signer.address }, /remote domain and admin/],
      [{ destinationDomain: 0 }, /destination must be Solana/],
      [{ caller: admin }, /destination caller/],
      [{ recipient: signer.address }, /Unsupported CCTP receiver/],
      [{ finality: 1999 }, /finalized attestations/],
    ] as const) {
      await assert.rejects(getCCTPV2ReceiveMessageTx(rpc, signer, message(defaultBody, overrides)), error);
    }
    await assert.rejects(getCCTPV2ReceiveMessageTx(rpc, signer, message(Buffer.alloc(4))), /no matching function/);
    await getCCTPV2ReceiveMessageTx(rpc, signer, message(defaultBody, { caller: signer.address }));
  });

  it("uses token mapping, attested recipient, custody and fee ATA for both token finalities", async () => {
    const signer = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;
    const local = (await generateKeyPairSigner()).address;
    const custody = (await generateKeyPairSigner()).address;
    const recipient = (await generateKeyPairSigner()).address;
    const pda = async (seeds: (string | ReadonlyUint8Array)[]) =>
      (await getProgramDerivedAddress({ programAddress: messenger, seeds }))[0];
    const pair = await pda(["token_pair", "0", encoder.encode(admin)]);
    const messengerState = await pda(["token_messenger"]);
    const accounts = new Map([
      [
        pair,
        account(
          TokenMessengerMinterV2Client.getTokenPairEncoder().encode({
            remoteDomain: 0,
            remoteToken: admin,
            localToken: local,
            bump: 1,
          }),
          messenger
        ),
      ],
      [
        local,
        account(
          TokenMessengerMinterV2Client.getLocalTokenEncoder().encode({
            custody,
            mint,
            burnLimitPerMessage: 0,
            messagesSent: 0,
            messagesReceived: 0,
            amountSent: 0,
            amountReceived: 0,
            bump: 1,
            custodyBump: 1,
          }),
          messenger
        ),
      ],
      [
        messengerState,
        account(
          TokenMessengerMinterV2Client.getTokenMessengerEncoder().encode({
            denylister: admin,
            owner: admin,
            pendingOwner: admin,
            messageBodyVersion: 1,
            authorityBump: 1,
            feeRecipient: signer.address,
            minFeeController: admin,
            minFee: 1,
          }),
          messenger
        ),
      ],
    ]);
    const { rpc } = rpcWithAccounts(accounts);
    const body = Buffer.alloc(228);
    body.writeUInt32BE(1);
    body.set(encoder.encode(admin), 4);
    body.set(encoder.encode(recipient), 36);
    body.writeBigUInt64BE(1_000_000n, 92);
    body.writeBigUInt64BE(500n, 156);
    body.writeBigUInt64BE(100n, 188);
    const decoded = decodeCCTPV2BurnMessage(body);
    expect(decoded.amount - decoded.feeExecuted).to.equal(999_900n);
    expect(decoded.maxFee).to.equal(500n);
    const feeAta = await getAssociatedTokenAddress(SvmAddress.from(signer.address), SvmAddress.from(mint));
    for (const finality of [1000, 2000]) {
      const msg = message(body, { recipient: messenger, finality });
      const metas = await getAccountMetasForCCTPV2TokenMessage(rpc, msg.messageBytes, recipient);
      expect(metas[3].address).to.equal(local);
      expect(metas[5]).to.deep.equal({ address: feeAta, role: AccountRole.WRITABLE });
      expect(metas[6].address).to.equal(recipient);
      expect(metas[7].address).to.equal(custody);
      await getCCTPV2ReceiveMessageTx(rpc, signer, msg, recipient);
      await assert.rejects(getCCTPV2ReceiveMessageTx(rpc, signer, msg, mint), /Unexpected CCTP mint recipient/);
    }
  });

  it("skips a processed message before fetching changed Spoke state", async () => {
    const { rpc, signer, accounts, getAccountInfo } = await spokeFixture();
    accounts.clear();
    accounts.set(
      await getCCTPNoncePda(nonce),
      account(MessageTransmitterV2Client.getUsedNonceEncoder().encode({ isUsed: true }), transmitter)
    );
    expect(await finalizeCCTPV2Messages(rpc, [message()], signer)).to.deep.equal([null]);
    expect(getAccountInfo.callCount).to.equal(1);
  });

  it("handles another finalizer winning the race, and propagates unrelated errors", async () => {
    const { rpc, signer, accounts } = await spokeFixture();
    const pda = await getCCTPNoncePda(nonce);
    const sendTransaction = sinon.stub().returns({
      send: () => Promise.reject(new Error("send failed")),
    });
    Object.assign(rpc, { sendTransaction });
    await assert.rejects(finalizeCCTPV2Messages(rpc, [message()], signer), /send failed/);
    sendTransaction.returns({
      send: () => {
        accounts.set(
          pda,
          account(MessageTransmitterV2Client.getUsedNonceEncoder().encode({ isUsed: true }), transmitter)
        );
        return Promise.reject(new Error("nonce used"));
      },
    });
    expect(await finalizeCCTPV2Messages(rpc, [message()], signer)).to.deep.equal([null]);
  });

  it("confirms successful delivery and rejects a landed transaction error", async () => {
    const { rpc, signer } = await spokeFixture();
    const sendTransaction = sinon.stub().returns({ send: () => Promise.resolve("submitted") });
    const getSignatureStatuses = sinon
      .stub()
      .returns({ send: () => Promise.resolve({ value: [{ confirmationStatus: "confirmed", err: null }] }) });
    Object.assign(rpc, { sendTransaction, getSignatureStatuses });
    const signatures = await finalizeCCTPV2Messages(rpc, [message()], signer);
    expect(signatures[0]).to.be.a("string").and.not.equal("");
    expect(getSignatureStatuses.firstCall.args[0]).to.deep.equal(signatures);
    getSignatureStatuses.returns({
      send: () =>
        Promise.resolve({
          value: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "InvalidArgument"] } }],
        }),
    });
    await assert.rejects(finalizeCCTPV2Messages(rpc, [message()], signer), /CCTP delivery failed/);
  });

  it("retries Iris indexing/rate limits/pending responses and selects by attested nonce", async () => {
    const fetch = sinon.stub(globalThis, "fetch");
    fetch.onCall(0).resolves(new Response("{}", { status: 404 }));
    fetch.onCall(1).resolves(new Response("{}", { status: 429 }));
    fetch.onCall(2).resolves(
      new Response(
        JSON.stringify({
          messages: [{ cctpVersion: 2, status: "pending_confirmations", message: "", attestation: "PENDING" }],
        })
      )
    );
    fetch.onCall(3).resolves(
      new Response(
        JSON.stringify({
          messages: [
            { cctpVersion: 1, status: "complete", message: "0x", attestation: "0x01" },
            ...[message(), message(defaultBody, { nonce: Buffer.alloc(32, 1) })].map((msg) => ({
              cctpVersion: 2,
              status: "complete",
              message: msg.messageBytes,
              attestation: msg.attestation,
            })),
          ],
        })
      )
    );
    expect(
      await fetchCCTPV2Messages("source-tx", 0, true, { nonce: ethers.utils.hexlify(nonce), pollIntervalMs: 1 })
    ).to.deep.equal([message()]);
    expect(fetch.callCount).to.equal(4);
  });

  it("rejects malformed completed attestations, V1-only responses, and times out pending messages", async () => {
    const fetch = sinon.stub(globalThis, "fetch");
    fetch.resolves(
      new Response(
        JSON.stringify({ messages: [{ cctpVersion: 1, status: "complete", message: "0x", attestation: "0x" }] })
      )
    );
    await assert.rejects(fetchCCTPV2Messages("tx", 0, true), /no CCTP V2/);
    fetch.resolves(
      new Response(
        JSON.stringify({
          messages: [{ cctpVersion: 2, status: "complete", message: message().messageBytes, attestation: "PENDING" }],
        })
      )
    );
    await assert.rejects(fetchCCTPV2Messages("tx", 0, true), /Invalid CCTP hex/);
    fetch.callsFake(() => Promise.resolve(new Response(JSON.stringify({ messages: [] }))));
    await assert.rejects(fetchCCTPV2Messages("tx", 0, true, { timeoutMs: 5, pollIntervalMs: 1 }), /Timed out/);
  });

  it("decodes historical liquidity events without adding them to active event queries", () => {
    expect(Object.keys(SVMEventNames)).not.to.include("TokensBridged");
    expect(Object.keys(SVMEventNames)).not.to.include("BridgedToHubPool");
    const bridged = Buffer.alloc(48);
    bridged.set([181, 111, 52, 218, 105, 53, 240, 205]);
    bridged.writeBigUInt64LE(42n, 8);
    bridged.set(encoder.encode(admin), 16);
    const decoded = decodeEvent(SvmSpokeEventsIdl, bridged.toString("base64"));
    expect(decoded.name).to.equal("BridgedToHubPool");
    expect(decoded.data).to.deep.equal({ amount: 42n, mint: admin });
    const tokens = Buffer.alloc(92);
    tokens.set([200, 201, 199, 39, 5, 238, 214, 196]);
    tokens.writeBigUInt64LE(123n, 8);
    tokens.writeBigUInt64LE(5n, 16);
    tokens.writeUInt32LE(7, 24);
    tokens.set(encoder.encode(admin), 28);
    tokens.set(encoder.encode(admin), 60);
    expect(decodeEvent(SvmSpokeEventsIdl, tokens.toString("base64"))).to.deep.equal({
      name: "TokensBridged",
      data: { amountToReturn: 123n, chainId: 5n, leafId: 7, l2TokenAddress: admin, caller: admin },
    });
  });
});
