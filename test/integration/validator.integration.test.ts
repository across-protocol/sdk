import {
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  Rpc,
  RpcSubscriptions,
  RpcTransport,
  SignatureNotificationsApi,
  SlotNotificationsApi,
  SolanaRpcApiFromTransport,
} from "@solana/kit";
import { expect } from "chai";
import validatorSetup from "../utils/validator.setup";
import validatorTeardown from "../utils/validator.teardown";

export const createDefaultSolanaClient = () => {
  const rpc = createSolanaRpc("http://127.0.0.1:8899");
  const rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900");
  return { rpc, rpcSubscriptions };
};

export type RpcClient = {
  rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>;
  rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
};

export const generateKeyPairSignerWithSol = async (rpcClient: RpcClient, putativeLamports: bigint = 1_000_000_000n) => {
  const signer = await generateKeyPairSigner();
  await airdropFactory(rpcClient)({
    recipientAddress: signer.address,
    lamports: lamports(putativeLamports),
    commitment: "confirmed",
  });
  return signer;
};

describe("Solana validator smoke‑test", () => {
  const solanaClient = createDefaultSolanaClient();

  before(async () => {
    await validatorSetup();
  });

  after(async () => {
    await validatorTeardown();
  });

  it("responds to getEpochInfo", async () => {
    const info = await solanaClient.rpc.getEpochInfo().send();
    expect(info.slotsInEpoch > 0n).to.be.true;
  });

  it("creates airdropped account and confirms balance", async () => {
    const kp = await generateKeyPairSignerWithSol(solanaClient, lamports(1_000_000_000n));
    const bal = await solanaClient.rpc.getBalance(kp.address).send();
    expect(bal.value > 0n).to.be.true;
  });
});
