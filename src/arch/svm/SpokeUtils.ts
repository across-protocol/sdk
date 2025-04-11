import { Deposit } from "../../interfaces";
import { SvmAddress, getTokenInformationFromAddress, BigNumber, isDefined, calculateRelayDataHash } from "../../utils";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createApproveCheckedInstruction,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { Address } from "@solana/kit";
import { SvmSpokeClient, findProgramAddress } from "@across-protocol/contracts";

/**
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @param deposit V3Deopsit instance.
 * @param relayer Address of the relayer filling the deposit.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function fillRelayInstruction(
  spokePool: SvmAddress,
  deposit: Omit<Deposit, "messageHash">,
  relayer: SvmAddress,
  recipientTokenAccount: SvmAddress,
  _repaymentChainId = deposit.destinationChainId
): Promise<SvmSpokeClient.FillRelayInstruction> {
  const programId = spokePool.toBase58();

  // @todo we need to convert the deposit's relayData to svm-like since the interface assumes the data originates from an EVM Spoke pool.
  // Once we migrate to `Address` types, this can be modified/removed.
  const {
    depositor: _depositor,
    recipient: _recipient,
    exclusiveRelayer: _exclusiveRelayer,
    inputToken: _inputToken,
    outputToken: _outputToken,
    inputAmount,
    outputAmount,
    originChainId,
    destinationChainId,
    depositId,
    fillDeadline,
    exclusivityDeadline,
    message: _message,
  } = deposit;
  const [depositor, recipient, exclusiveRelayer, inputToken, outputToken] = [
    _depositor,
    _recipient,
    _exclusiveRelayer,
    _inputToken,
    _outputToken,
  ].map((addr) => SvmAddress.from(addr));

  const relayData = {
    depositor: depositor.toBase58(),
    recipient: recipient.toBase58(),
    exclusiveRelayer: exclusiveRelayer.toBase58(),
    inputToken: inputToken.toBase58(),
    outputToken: outputToken.toBase58(),
    inputAmount,
    outputAmount,
    originChainId,
    depositId,
    fillDeadline,
    exclusivityDeadline,
    message: Buffer.from(_message, "hex"),
  };
  const _relayDataHash = calculateRelayDataHash(
    {
      ...relayData,
      depositor: deposit.depositor,
      recipient: deposit.recipient,
      exclusiveRelayer: deposit.exclusiveRelayer,
      inputToken: deposit.inputToken,
      outputToken: deposit.outputToken,
      message: deposit.message,
    },
    destinationChainId
  );
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  // Create ATA for the relayer and recipient token accounts
  const relayerTokenAccount = getAssociatedTokenAddressSync(
    outputToken.toPublicKey(),
    relayer.toPublicKey(),
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { publicKey: statePda } = findProgramAddress("state", spokePool.toPublicKey(), ["0"]);
  const { publicKey: fillStatusPda } = findProgramAddress("fills", spokePool.toPublicKey(), [relayDataHash.toString()]);

  const fillAccounts = {
    state: statePda,
    signer: relayer.toBase58(),
    instructionParams: programId,
    mint: outputToken.toBase58(),
    relayerTokenAccount: relayerTokenAccount,
    recipientTokenAccount: recipientTokenAccount.toBase58(),
    fillStatus: fillStatusPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    programId: programId,
    program: programId,
  };
  return SvmSpokeClient.getFillRelayInstruction(fillAccounts);
}

/**
 * @param mint Address of the token corresponding to the account being made.
 * @param relayer Address of the relayer filling the deposit.
 * @returns An instruction for creating a new token account.
 */
export function createTokenAccountsInstruction(
  mint: SvmAddress,
  relayer: SvmAddress
): SvmSpokeClient.CreateTokenAccountsInstruction {
  return SvmSpokeClient.getCreateTokenAccountsInstruction({
    signer: relayer.toV2Address(),
    mint: mint.toV2Address(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58() as Address<string>,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() as Address<string>,
  });
}

/**
 * @param mint Address of the token corresponding to the account being made.
 * @param amount Amount of the token to approve.
 * @param relayer Address of the relayer filling the deposit.
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @returns A token approval instruction.
 */
export async function createApproveInstruction(
  mint: SvmAddress,
  amount: BigNumber,
  relayer: SvmAddress,
  spokePool: SvmAddress
) {
  const relayerTokenAccount = getAssociatedTokenAddressSync(
    mint.toPublicKey(),
    relayer.toPublicKey(),
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const { publicKey: statePda } = findProgramAddress("state", spokePool.toPublicKey(), ["0"]);
  const tokenInfo = getTokenInformationFromAddress(mint.toBase58());

  // FIXME: This will cause any bot to crash if the token being relayed is not in `TOKEN_SYMBOLS_MAP`, which is
  // going to break lots of integrations post-v4.
  if (!isDefined(tokenInfo)) {
    throw new Error(`${mint.toBase58()} is not a recognized token in TOKEN_SYMBOLS_MAP`);
  }

  return await createApproveCheckedInstruction(
    relayerTokenAccount,
    mint.toPublicKey(),
    statePda,
    relayer.toPublicKey(),
    BigInt(amount.toString()),
    tokenInfo!.decimals,
    undefined,
    TOKEN_PROGRAM_ID
  );
}
