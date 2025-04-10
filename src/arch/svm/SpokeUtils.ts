import { Deposit } from "../../interfaces";
import { EvmAddress, Address, SvmAddress } from "../../utils";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { calculateRelayHashUint8Array, SvmSpokeClient, findProgramAddress } from "@across-protocol/contracts";

/**
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @param deposit V3Deopsit instance.
 * @param relayer Address of the relayer filling the deposit.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function fillV3RelayInstruction(
  spokePool: SvmAddress,
  deposit: Omit<Deposit, "messageHash">,
  relayer: Address,
  recipientTokenAccount: SvmAddress,
  repaymentChainId = deposit.destinationChainId
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
  ].map((addr) => EvmAddress.from(addr).toBase58());
  const relayData = {
    depositor,
    recipient,
    exclusiveRelayer,
    inputToken,
    outputToken,
    inputAmount,
    outputAmount,
    originChainId,
    depositId,
    fillDeadline,
    exclusivityDeadline,
    message: Buffer.from(_message),
  };
  const relayDataHash = calculateRelayHashUint8Array(relayData, repaymentChainId);

  // Create ATA for the relayer and recipient token accounts
  const relayerTokenAccount = getAssociatedTokenAddressSync(
    outputToken,
    relayer.toBase58(),
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { publicKey: statePda } = findProgramAddress("state", programId, []); // TODO: I think there needs to be a seed here.
  const { publicKey: fillStatusPda } = findProgramAddress("fills", programId, [relayDataHash]);

  const fillAccounts = {
    state: statePda,
    signer: relayer.toBase58(),
    instructionParams: programId,
    mint: outputToken,
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
