import { SvmSpokeClient } from "@across-protocol/contracts";
import { getSolanaChainId } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { getCreateAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
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
  getSignatureFromTransaction,
  KeyPairSigner,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  TransactionMessageWithBlockhashLifetime,
  TransactionSigner,
} from "@solana/kit";
import {
  getAssociatedTokenAddress,
  getEventAuthority,
  getRoutePda,
  getStatePda,
  RpcClient,
  SVM_SPOKE_SEED,
} from "../../../src/arch/svm";
import { SvmAddress } from "../../../src/utils";

/** RPC / Client */

// Creates an RPC+WebSocket client pointing to local validator.
export const createDefaultSolanaClient = () => {
  const rpc = createSolanaRpc("http://127.0.0.1:8899");
  const rpcSubscriptions = createSolanaRpcSubscriptions("ws://127.0.0.1:8900");
  return { rpc, rpcSubscriptions };
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
  const payerAta = await getAssociatedTokenAddress(SvmAddress.from(payer.address), SvmAddress.from(mint), tokenProgram);

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

/** SVM Spoke Workflows */

// Initialises the SVM Spoke program on Solana.
export const initializeSvmSpoke = async (
  signer: KeyPairSigner,
  solanaClient: RpcClient,
  crossDomainAdmin: Address,
  initialNumberOfDeposits = 0,
  depositQuoteTimeBuffer = 3600,
  fillDeadlineBuffer = 4 * 3600,
  seed = SVM_SPOKE_SEED
) => {
  const state = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);

  const initializeInput: SvmSpokeClient.InitializeInput = {
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
  const initializeIx = await SvmSpokeClient.getInitializeInstruction(initializeInput);

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
  const vault = await getAssociatedTokenAddress(SvmAddress.from(state), SvmAddress.from(mint), tokenProgram);

  const createAssociatedTokenIdempotentIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    owner: state,
    mint,
    ata: vault,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    tokenProgram,
  });

  const route = await getRoutePda(mint, 0n, destinationChainId);
  const eventAuthority = await getEventAuthority();

  const input: SvmSpokeClient.SetEnableRouteInput = {
    signer,
    state,
    vault,
    payer: signer,
    route,
    originTokenMint: mint,
    tokenProgram,
    associatedTokenProgram,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    program: address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    originToken: mint,
    destinationChainId,
    enabled: true,
    eventAuthority,
  };
  const setEnableRouteIx = await SvmSpokeClient.getSetEnableRouteInstruction(input);

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
  solanaClient: RpcClient,
  depositInput: SvmSpokeClient.DepositInput,
  tokenDecimals: number
) => {
  const approveIx = getApproveCheckedInstruction({
    source: depositInput.depositorTokenAccount,
    mint: depositInput.mint,
    delegate: depositInput.state,
    owner: depositInput.depositor,
    amount: depositInput.inputAmount,
    decimals: tokenDecimals,
  });

  const depositIx = await SvmSpokeClient.getDepositInstruction(depositInput);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(depositIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
};

// Requests a slow fill
export const requestSlowFill = async (
  signer: KeyPairSigner,
  solanaClient: RpcClient,
  depositInput: SvmSpokeClient.RequestSlowFillInput
) => {
  const requestSlowFillIx = await SvmSpokeClient.getRequestSlowFillInstruction(depositInput);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(requestSlowFillIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
};

// Creates a fill
export const createFill = async (
  signer: KeyPairSigner,
  solanaClient: RpcClient,
  fillInput: SvmSpokeClient.FillRelayInput,
  tokenDecimals: number
) => {
  const approveIx = getApproveCheckedInstruction({
    source: fillInput.relayerTokenAccount,
    mint: fillInput.mint,
    delegate: fillInput.state,
    owner: fillInput.signer,
    amount: (fillInput.relayData as SvmSpokeClient.RelayDataArgs).outputAmount,
    decimals: tokenDecimals,
  });

  const createAssociatedTokenIdempotentIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: signer,
    owner: (fillInput.relayData as SvmSpokeClient.RelayDataArgs).recipient,
    mint: fillInput.mint,
    ata: fillInput.recipientTokenAccount,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    tokenProgram: fillInput.tokenProgram,
  });

  const createFillIx = await SvmSpokeClient.getFillRelayInstruction(fillInput);

  return pipe(
    await createDefaultTransaction(solanaClient, signer),
    (tx) => appendTransactionMessageInstruction(createAssociatedTokenIdempotentIx, tx),
    (tx) => appendTransactionMessageInstruction(approveIx, tx),
    (tx) => appendTransactionMessageInstruction(createFillIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
};
