import { SvmSpokeClient } from "@across-protocol/contracts";
import {
  DepositInput,
  InitializeAsyncInput,
  SetEnableRouteInput,
} from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { getSolanaChainId } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { getCreateAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  Address,
  address,
  airdropFactory,
  appendTransactionMessageInstruction,
  Commitment,
  CompilableTransactionMessage,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  KeyPairSigner,
  lamports,
  pipe,
  ReadonlyUint8Array,
  Rpc,
  RpcSubscriptions,
  RpcTransport,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  SignatureNotificationsApi,
  signTransactionMessageWithSigners,
  SlotNotificationsApi,
  SolanaRpcApiFromTransport,
  TransactionMessageWithBlockhashLifetime,
  TransactionSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { ethers } from "ethers";

/** RPC / Client */

// Creates an RPC+WebSocket client pointing to local validator.
export const createDefaultSolanaClient = () => {
  const rpc = createSolanaRpc("http://127.0.0.1:8899");
  const rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900");
  return { rpc, rpcSubscriptions };
};

// Typed aggregate of JSON‑RPC and subscription clients.
export type RpcClient = {
  rpc: Rpc<SolanaRpcApiFromTransport<RpcTransport>>;
  rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
};

/** Wallet & Transaction */

// Generates a new key‑pair signer and airdrops SOL to it.
export const generateKeyPairSignerWithSol = async (rpcClient: RpcClient, putativeLamports: bigint = 1_000_000_000n) => {
  const signer = await generateKeyPairSigner();
  await airdropFactory(rpcClient)({
    recipientAddress: signer.address,
    lamports: lamports(putativeLamports),
    commitment: "confirmed",
  });
  return signer;
};

// Signs, sends and confirms a compiled transaction message.
export const signAndSendTransaction = async (
  rpcClient: RpcClient,
  transactionMessage: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime,
  commitment: Commitment = "confirmed"
) => {
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  const signature = getSignatureFromTransaction(signedTransaction);
  await sendAndConfirmTransactionFactory(rpcClient)(signedTransaction, { commitment });
  return signature;
};

// Creates a pre‑populated version‑0 transaction skeleton.
export const createDefaultTransaction = async (rpcClient: RpcClient, signer: TransactionSigner) => {
  const { value: latestBlockhash } = await rpcClient.rpc.getLatestBlockhash().send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx)
  );
};

/** Token ‒ Minting & ATA */

// Creates and initialises a new mint account.
export async function createMint(
  payer: KeyPairSigner,
  client: RpcClient,
  decimals = 6,
  tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS,
  mintSize = getMintSize()
) {
  const [mint, mintRent] = await Promise.all([
    generateKeyPairSigner(),
    client.rpc.getMinimumBalanceForRentExemption(BigInt(mintSize)).send(),
  ]);

  const createAccountIx = getCreateAccountInstruction({
    payer,
    newAccount: mint,
    space: mintSize,
    lamports: mintRent,
    programAddress: tokenProgram,
  });

  const mintAuthority = payer.address;
  const freezeAuthority = payer.address;

  const initializeMintIx = getInitializeMintInstruction({
    mint: mint.address,
    decimals,
    mintAuthority,
    freezeAuthority,
  });

  await pipe(
    await createDefaultTransaction(client, payer),
    (tx) => appendTransactionMessageInstruction(createAccountIx, tx),
    (tx) => appendTransactionMessageInstruction(initializeMintIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  return { mint, decimals, mintAuthority, freezeAuthority };
}

// Mints tokens to payer's associated token account.
export async function mintTokens(
  payer: KeyPairSigner,
  client: RpcClient,
  mint: Address,
  amount: bigint,
  tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS
) {
  const [payerAta] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram,
    mint,
  });

  const createAssociatedTokenIdempotentIx = getCreateAssociatedTokenIdempotentInstruction({
    payer,
    owner: payer.address,
    mint,
    ata: payerAta,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    tokenProgram,
  });

  const mintTx = getMintToInstruction({
    mint,
    token: payerAta,
    mintAuthority: payer.address,
    amount,
  });

  await pipe(
    await createDefaultTransaction(client, payer),
    (tx) => appendTransactionMessageInstruction(createAssociatedTokenIdempotentIx, tx),
    (tx) => appendTransactionMessageInstruction(mintTx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  return payerAta;
}

/** PDA & Utility */

export function getRandomSvmAddress() {
  const bytes = ethers.utils.randomBytes(32);
  const base58Address = bs58.encode(bytes);
  return address(base58Address);
}

// Encodes a bigint into a fixed‑length little‑endian Buffer.
export function toLEBuffer(value: bigint, byteLen = 8): Buffer {
  const buf = Buffer.alloc(byteLen);
  let v = value;
  for (let i = 0; i < byteLen; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`Value ${value} overflows ${byteLen} bytes`);
  return buf;
}

// Converts a base‑58 address string to a Buffer.
export function addressToBuffer(addr: Address): Buffer {
  return Buffer.from(bs58.decode(addr.toString()));
}

// Derives the PDA for a route account on SVM Spoke.
export async function createRoutePda(originToken: Address, seed: bigint, routeChainId: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: [Buffer.from("route"), addressToBuffer(originToken), toLEBuffer(seed, 8), toLEBuffer(routeChainId, 8)],
  });
  return pda;
}

const STATE_SEED = 0n;

// Derives the global State PDA for SVM Spoke.
export const getStatePda = async () => {
  const [state] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: [Buffer.from("state"), toLEBuffer(STATE_SEED, 8)],
  });
  return state;
};

// Derives the SPL Event Authority PDA used by SVM Spoke.
export const getEventAuthority = async () => {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    seeds: ["__event_authority"],
  });
  return eventAuthority;
};

/** SVM Spoke Workflows */

// Initialises the SVM Spoke program on Solana.
export const initializeSvmSpoke = async (
  signer: KeyPairSigner,
  solanaClient: RpcClient,
  crossDomainAdmin: Address,
  initialNumberOfDeposits = 0,
  depositQuoteTimeBuffer = 3600,
  fillDeadlineBuffer = 4 * 3600,
  seed = STATE_SEED
) => {
  const state = await getStatePda();

  const initializeInput: InitializeAsyncInput = {
    signer,
    state,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    seed,
    initialNumberOfDeposits,
    chainId: BigInt(getSolanaChainId("mainnet").toString()),
    remoteDomain: 1,
    crossDomainAdmin,
    depositQuoteTimeBuffer,
    fillDeadlineBuffer,
  };
  const initializeIx = await SvmSpokeClient.getInitializeInstructionAsync(initializeInput);

  await pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(initializeIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
  return { state };
};

// Enables a token route and creates the program vault ATA.
export const enableRoute = async (
  signer: KeyPairSigner,
  solanaClient: RpcClient,
  destinationChainId: bigint,
  state: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS,
  associatedTokenProgram: Address = ASSOCIATED_TOKEN_PROGRAM_ADDRESS
) => {
  const [vault] = await findAssociatedTokenPda({
    owner: state,
    tokenProgram,
    mint,
  });

  const createAssociatedTokenIdempotentIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    owner: state,
    mint,
    ata: vault,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    tokenProgram,
  });

  const route = await createRoutePda(mint, 0n, destinationChainId);
  const eventAuthority = await getEventAuthority();

  const input: SetEnableRouteInput = {
    signer,
    state,
    vault,
    payer: signer,
    route,
    originTokenMint: mint,
    tokenProgram,
    associatedTokenProgram,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    eventAuthority,
    program: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    originToken: mint,
    destinationChainId,
    enabled: true,
  };
  const setEnableRouteIx = await SvmSpokeClient.getSetEnableRouteInstructionAsync(input);

  await pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(createAssociatedTokenIdempotentIx, tx),
    (tx) => appendTransactionMessageInstruction(setEnableRouteIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
  return { vault, route };
};

// Executes a deposit into the SVM Spoke vault.
export const deposit = async (
  signer: KeyPairSigner,
  depositData: {
    depositor: Address;
    recipient: Address;
    inputToken: Address;
    outputToken: Address;
    inputAmount: bigint;
    outputAmount: bigint;
    destinationChainId: number;
    exclusiveRelayer: Address;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityParameter: number;
    message: ReadonlyUint8Array;
  },
  depositAccounts: {
    state: Address;
    route: Address;
    signer: Address;
    depositorTokenAccount: Address;
    vault: Address;
    mint: Address;
    tokenProgram: Address;
    program: Address;
  },
  tokenDecimals: number,
  solanaClient: RpcClient
) => {
  const eventAuthority = await getEventAuthority();

  const approveIx = getApproveCheckedInstruction({
    source: depositAccounts.depositorTokenAccount,
    mint: depositAccounts.mint,
    delegate: depositAccounts.state,
    owner: depositData.depositor,
    amount: depositData.inputAmount,
    decimals: tokenDecimals,
  });

  const depositInput: DepositInput = {
    ...depositData,
    ...depositAccounts,
    eventAuthority,
    signer,
  };

  const depositIx = await SvmSpokeClient.getDepositInstructionAsync(depositInput);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(depositIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
};
