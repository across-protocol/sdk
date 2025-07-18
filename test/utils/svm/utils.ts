import { CHAIN_IDs } from "@across-protocol/constants";
import { SpokePool__factory, SvmSpokeClient } from "@across-protocol/contracts";
import { RelayDataArgs } from "@across-protocol/contracts/dist/src/svm/clients/SvmSpoke";
import { intToU8Array32 } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { SYSTEM_PROGRAM_ADDRESS, getCreateAccountInstruction } from "@solana-program/system";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token-2022";
import {
  Address,
  Commitment,
  CompilableTransactionMessage,
  KeyPairSigner,
  TransactionMessageWithBlockhashLifetime,
  address,
  airdropFactory,
  appendTransactionMessageInstruction,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { ethers } from "ethers";
import { arrayify, hexlify } from "ethers/lib/utils";
import {
  RpcClient,
  SVM_DEFAULT_ADDRESS,
  SVM_SPOKE_SEED,
  bigToU8a32,
  createDefaultTransaction,
  createDepositInstruction,
  createFillInstruction,
  createRequestSlowFillInstruction,
  getAssociatedTokenAddress,
  getDepositDelegatePda,
  getEventAuthority,
  getFillRelayDelegatePda,
  getFillStatusPda,
  getRandomSvmAddress,
  getStatePda,
  toAddress,
  numberToU8a32,
} from "../../../src/arch/svm";
import { RelayData } from "../../../src/interfaces";
import {
  BigNumber,
  EvmAddress,
  SvmAddress,
  getRandomInt,
  getRelayDataHash,
  randomAddress,
  toAddressType,
} from "../../../src/utils";

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
    await createDefaultTransaction(client.rpc, payer),
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
    await createDefaultTransaction(client.rpc, payer),
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
    chainId: BigInt(CHAIN_IDs.SOLANA),
    remoteDomain: 0,
    crossDomainAdmin,
    depositQuoteTimeBuffer,
    fillDeadlineBuffer,
  };
  const initializeIx = SvmSpokeClient.getInitializeInstruction(initializeInput);

  await pipe(
    await createDefaultTransaction(solanaClient.rpc, signer),
    (tx) => appendTransactionMessageInstruction(initializeIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
  return { state };
};

// Sets the current time for the SVM Spoke program.
export const setCurrentTime = async (signer: KeyPairSigner, solanaClient: RpcClient, newTime: number) => {
  const setCurrentTimeIx = await SvmSpokeClient.getSetCurrentTimeInstruction({
    signer,
    state: await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    newTime,
  });
  return pipe(
    await createDefaultTransaction(solanaClient.rpc, signer),
    (tx) => appendTransactionMessageInstruction(setCurrentTimeIx, tx),
    (tx) => signAndSendTransaction(solanaClient, tx)
  );
};

export const getCurrentTime = async (solanaClient: RpcClient) => {
  const statePda = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);
  return state.data.currentTime;
};

// helper to send a fill
export const sendCreateFill = async (
  solanaClient: RpcClient,
  signer: KeyPairSigner,
  mint: KeyPairSigner,
  mintDecimals: number,
  overrides: Partial<RelayDataArgs> = {}
) => {
  const currentTime = await getCurrentTime(solanaClient);

  const relayData: SvmSpokeClient.FillRelayInput["relayData"] = {
    depositor:
      overrides.depositor ?? toAddressType(address(EvmAddress.from(randomAddress()).toBase58()), CHAIN_IDs.MAINNET),
    recipient: overrides.recipient ?? toAddressType(getRandomSvmAddress(), CHAIN_IDs.SOLANA),
    exclusiveRelayer: overrides.exclusiveRelayer ?? toAddressType(SVM_DEFAULT_ADDRESS, CHAIN_IDs.SOLANA),
    inputToken:
      overrides.inputToken ?? toAddressType(address(EvmAddress.from(randomAddress()).toBase58()), CHAIN_IDs.MAINNET),
    outputToken: toAddressType(mint.address),
    inputAmount: overrides.inputAmount ?? bigToU8a32(BigNumber.from(getRandomInt())),
    outputAmount: overrides.outputAmount ?? getRandomInt(),
    originChainId: overrides.originChainId ?? CHAIN_IDs.MAINNET,
    depositId: overrides.depositId ?? new Uint8Array(intToU8Array32(getRandomInt())),
    fillDeadline: overrides.fillDeadline ?? Number(currentTime) + 60 * 30,
    exclusivityDeadline: overrides.exclusivityDeadline ?? 0,
    message: overrides.message ?? new Uint8Array(),
  };

  const formattedRelayData = formatRelayData(relayData);
  const relayDataHash = getRelayDataHash(formattedRelayData, CHAIN_IDs.SOLANA);
  const fillStatusPda = await getFillStatusPda(
    SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    formattedRelayData,
    CHAIN_IDs.SOLANA
  );

  const payerAta = await getAssociatedTokenAddress(
    SvmAddress.from(signer.address),
    SvmAddress.from(mint.address),
    TOKEN_2022_PROGRAM_ADDRESS
  );

  const recipientAta = await getAssociatedTokenAddress(
    relayData.recipient,
    SvmAddress.from(mint.address),
    TOKEN_2022_PROGRAM_ADDRESS
  );

  const delegatePda = await getFillRelayDelegatePda(
    new Uint8Array(Buffer.from(relayDataHash.slice(2), "hex")),
    BigInt(CHAIN_IDs.SOLANA),
    signer.address,
    SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS
  );

  const relayDataInput = {
    ...relayData,
    inputToken: toAddress(relayData.inputToken),
    outputToken: toAddress(relayData.outputToken),
    depositor: toAddress(relayData.depositor),
    recipient: toAddress(relayData.recipient),
    exclusiveRelayer: toAddress(relayData.exclusiveRelayer),
  };

  const fillInput: SvmSpokeClient.FillRelayInput = {
    signer: signer,
    delegate: toAddress(SvmAddress.from(delegatePda.toString())),
    instructionParams: undefined,
    state: await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    mint: mint.address,
    relayerTokenAccount: payerAta,
    recipientTokenAccount: recipientAta,
    fillStatus: fillStatusPda,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    eventAuthority: await getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    relayHash: arrayify(relayDataHash),
    relayData: relayDataInput,
    repaymentChainId: BigInt(CHAIN_IDs.SOLANA),
    repaymentAddress: signer.address,
  };

  const fillTx = await createFillInstruction(signer, solanaClient.rpc, fillInput, mintDecimals);
  const signature = await signAndSendTransaction(solanaClient, fillTx);
  return { signature, relayData, fillInput };
};

// helper to send a request slow fill
export const sendRequestSlowFill = async (
  solanaClient: RpcClient,
  signer: KeyPairSigner,
  overrides: Partial<RelayDataArgs> = {}
) => {
  const destinationChainId = CHAIN_IDs.SOLANA;
  const currentTime = await getCurrentTime(solanaClient);

  const relayData: SvmSpokeClient.RequestSlowFillInstructionDataArgs["relayData"] = {
    depositor: overrides.depositor ?? EvmAddress.from(randomAddress()),
    recipient: overrides.recipient ?? toAddressType(getRandomSvmAddress(), CHAIN_IDs.SOLANA),
    exclusiveRelayer: overrides.exclusiveRelayer ?? toAddressType(SVM_DEFAULT_ADDRESS, CHAIN_IDs.SOLANA),
    inputToken: overrides.inputToken ?? EvmAddress.from(randomAddress()),
    outputToken: overrides.outputToken ?? toAddressType(getRandomSvmAddress(), CHAIN_IDs.SOLANA),
    inputAmount: overrides.inputAmount ?? numberToU8a32(getRandomInt()),
    outputAmount: overrides.outputAmount ?? getRandomInt(),
    originChainId: overrides.originChainId ?? CHAIN_IDs.MAINNET,
    depositId: overrides.depositId ?? new Uint8Array(intToU8Array32(getRandomInt())),
    fillDeadline: overrides.fillDeadline ?? Number(currentTime) + 60 * 30,
    exclusivityDeadline: overrides.exclusivityDeadline ?? 0,
    message: overrides.message ?? new Uint8Array(),
  };
  const formattedRelayData = formatRelayData(relayData);
  const relayDataHash = getRelayDataHash(formattedRelayData, destinationChainId);
  const fillStatusPda = await getFillStatusPda(
    SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    formattedRelayData,
    destinationChainId
  );

  const relayDataInput = {
    ...relayData,
    inputToken: toAddress(relayData.inputToken),
    outputToken: toAddress(relayData.outputToken),
    depositor: toAddress(relayData.depositor),
    recipient: toAddress(relayData.recipient),
    exclusiveRelayer: toAddress(relayData.exclusiveRelayer),
  };

  const requestSlowFillInput: SvmSpokeClient.RequestSlowFillInput = {
    program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    relayHash: arrayify(relayDataHash),
    relayData: relayDataInput,
    state: await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    fillStatus: fillStatusPda,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    eventAuthority: await getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    signer,
  };
  const requestSlowFillTx = await createRequestSlowFillInstruction(signer, solanaClient.rpc, requestSlowFillInput);
  const signature = await signAndSendTransaction(solanaClient, requestSlowFillTx);
  return { signature, relayData };
};

// helper to create a deposit
export const sendCreateDeposit = async (
  solanaClient: RpcClient,
  signer: KeyPairSigner,
  mint: KeyPairSigner,
  mintDecimals: number,
  payerAta: Address,
  overrides: Partial<SvmSpokeClient.DepositInput> = {},
  destinationChainId: number = CHAIN_IDs.MAINNET
) => {
  const currentTime = await getCurrentTime(solanaClient);

  const state = await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const tokenProgram = TOKEN_2022_PROGRAM_ADDRESS;
  const vault = await getAssociatedTokenAddress(SvmAddress.from(state), SvmAddress.from(mint.address), tokenProgram);

  const depositInput: SvmSpokeClient.DepositInput = {
    depositor: signer.address,
    delegate: address(EvmAddress.from(randomAddress()).toBase58()), // Random address for now but calculated later
    recipient: overrides.recipient ?? address(EvmAddress.from(randomAddress()).toBase58()),
    inputToken: mint.address,
    outputToken: overrides.outputToken ?? address(EvmAddress.from(randomAddress()).toBase58()),
    inputAmount: overrides.inputAmount ?? getRandomInt(),
    outputAmount: overrides.outputAmount ?? numberToU8a32(getRandomInt()),
    destinationChainId: destinationChainId,
    exclusiveRelayer: overrides.exclusiveRelayer ?? address(EvmAddress.from(randomAddress()).toBase58()),
    quoteTimestamp: overrides.quoteTimestamp ?? Number(currentTime),
    fillDeadline: overrides.fillDeadline ?? Number(currentTime) + 60 * 30, // 30‑minute deadline
    exclusivityParameter: overrides.exclusivityParameter ?? 1,
    message: overrides.message ?? new Uint8Array(),
    state: await getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    depositorTokenAccount: payerAta,
    vault,
    mint: mint.address,
    tokenProgram,
    program: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    eventAuthority: await getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    signer,
  };

  const depositDataSeed: Parameters<typeof getDepositDelegatePda>[0] = {
    depositor: depositInput.depositor,
    recipient: depositInput.recipient,
    inputToken: depositInput.inputToken,
    outputToken: depositInput.outputToken,
    inputAmount: BigInt(depositInput.inputAmount),
    outputAmount: depositInput.outputAmount,
    destinationChainId: BigInt(destinationChainId),
    exclusiveRelayer: depositInput.exclusiveRelayer,
    quoteTimestamp: BigInt(depositInput.quoteTimestamp),
    fillDeadline: BigInt(depositInput.fillDeadline),
    exclusivityParameter: BigInt(depositInput.exclusivityParameter),
    message: new Uint8Array(depositInput.message),
  };

  const pda = await getDepositDelegatePda(depositDataSeed, SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  depositInput.delegate = pda;

  const depositTx = await createDepositInstruction(signer, solanaClient.rpc, depositInput, mintDecimals);
  const signature = await signAndSendTransaction(solanaClient, depositTx);
  return { signature, depositInput };
};

/**
 * Helper: Encodes a `pauseDeposits` call and returns it as a Buffer.
 * @param pause Whether deposits should be paused. Defaults to `true`.
 */
export const encodePauseDepositsMessageBody = (pause = true): Buffer => {
  const spokePoolInterface = new ethers.utils.Interface(SpokePool__factory.abi);
  const calldata = spokePoolInterface.encodeFunctionData("pauseDeposits", [pause]);
  return Buffer.from(calldata.slice(2), "hex");
};

/** Relay Data Utils */

export const formatRelayData = (relayData: SvmSpokeClient.RelayDataArgs): RelayData => {
  return {
    originChainId: Number(relayData.originChainId),
    depositor: relayData.depositor,
    depositId: BigNumber.from(relayData.depositId),
    recipient: relayData.recipient,
    inputToken: relayData.inputToken,
    outputToken: relayData.outputToken,
    inputAmount: BigNumber.from(relayData.inputAmount),
    outputAmount: BigNumber.from(relayData.outputAmount),
    fillDeadline: relayData.fillDeadline,
    exclusivityDeadline: relayData.exclusivityDeadline,
    message: hexlify(relayData.message),
    exclusiveRelayer: relayData.exclusiveRelayer,
  };
};
