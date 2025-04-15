import {
  SvmAddress,
  getTokenInformationFromAddress,
  BigNumber,
  isDefined,
  getRelayDataHash,
  isUnsafeDepositId,
} from "../../utils";
import { TOKEN_PROGRAM_ID, createApproveCheckedInstruction } from "@solana/spl-token";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Address, Rpc, SolanaRpcApi, some, getProgramDerivedAddress, type TransactionSigner } from "@solana/kit";
import { SvmSpokeClient, findProgramAddress } from "@across-protocol/contracts";
import { Deposit, FillStatus, FillWithBlock, RelayData } from "../../interfaces";

export type Provider = Rpc<SolanaRpcApi>;

/**
 * @param spokePool SpokePool Contract instance.
 * @param deposit V3Deopsit instance.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function populateV3Relay(
  _spokePool: unknown,
  _deposit: Omit<Deposit, "messageHash">,
  _relayer: string,
  _repaymentChainId = _deposit.destinationChainId
): Promise<unknown> {
  throw new Error("populateV3Relay: not implemented");
}

/**
 * Retrieves the time from the SpokePool contract at a particular block.
 * @returns The time at the specified block tag.
 */
export function getTimeAt(_spokePool: unknown, _blockNumber: number): Promise<number> {
  throw new Error("getTimeAt: not implemented");
}

/**
 * Retrieves the chain time at a particular block.
 * @note This should be the same as getTimeAt() but can differ in test. These two functions should be consolidated.
 * @returns The chain time at the specified block tag.
 */
export async function getTimestampForBlock(provider: Provider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(BigInt(blockNumber)).send();
  let timestamp: number;
  if (!block?.blockTime) {
    console.error(`Unable to resolve svm block ${blockNumber}`);
    timestamp = 0; // @todo: How to handle this?
  } else {
    timestamp = Number(block.blockTime); // Unix timestamps fit within number.
  }

  return timestamp;
}

/**
 * Return maximum of fill deadline buffer at start and end of block range.
 * @param spokePool SpokePool contract instance
 * @param startBlock start block
 * @param endBlock end block
 * @returns maximum of fill deadline buffer at start and end block
 */
export function getMaxFillDeadlineInRange(
  _spokePool: unknown,
  _startBlock: number,
  _endBlock: number
): Promise<number> {
  throw new Error("getMaxFillDeadlineInRange: not implemented");
}

/**
 * Finds the deposit id at a specific block number.
 * @param blockTag The block number to search for the deposit ID at.
 * @returns The deposit ID.
 */
export function getDepositIdAtBlock(_contract: unknown, _blockTag: number): Promise<BigNumber> {
  throw new Error("getDepositIdAtBlock: not implemented");
}

/**
 * xxx todo
 */
export async function getSlotForBlock(
  provider: Provider,
  blockNumber: bigint,
  lowSlot: bigint,
  _highSlot?: bigint
): Promise<bigint | undefined> {
  // @todo: Factor getBlock out to SlotFinder ??
  const getBlockNumber = async (slot: bigint): Promise<bigint> => {
    const block = await provider
      .getBlock(slot, { transactionDetails: "none", maxSupportedTransactionVersion: 0 })
      .send();
    return block?.blockHeight ?? BigInt(0); // @xxx Handle undefined here!
  };

  let highSlot = _highSlot ?? (await provider.getSlot().send());
  const [blockLow = 0, blockHigh = 1_000_000_000] = await Promise.all([
    getBlockNumber(lowSlot),
    getBlockNumber(highSlot),
  ]);

  if (blockLow > blockNumber || blockHigh < blockNumber) {
    return undefined; // blockNumber did not occur within the specified block range.
  }

  // Find the lowest slot number where blockHeight is greater than the requested blockNumber.
  do {
    const midSlot = (highSlot + lowSlot) / BigInt(2);
    const midBlock = await getBlockNumber(midSlot);

    if (midBlock < blockNumber) {
      lowSlot = midSlot + BigInt(1);
    } else if (midBlock > blockNumber) {
      highSlot = midSlot + BigInt(1); // blockNumber occurred at or earlier than midBlock.
    } else {
      return midSlot;
    }
  } while (lowSlot <= highSlot);

  return undefined;
}

export function findDepositBlock(
  _spokePool: unknown,
  depositId: BigNumber,
  _lowBlock: number,
  _highBlock?: number
): Promise<number | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }
  throw new Error("findDepositBlock: not implemented");
}

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export function relayFillStatus(
  _spokePool: unknown,
  _relayData: RelayData,
  _blockTag?: number | "latest",
  _destinationChainId?: number
): Promise<FillStatus> {
  throw new Error("relayFillStatus: not implemented");
}

export function fillStatusArray(
  _spokePool: unknown,
  _relayData: RelayData[],
  _blockTag = "processed"
): Promise<(FillStatus | undefined)[]> {
  throw new Error("fillStatusArray: not implemented");
}

/**
 * Find the block at which a fill was completed.
 * @todo After SpokePool upgrade, this function can be simplified to use the FillStatus enum.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param lowBlockNumber The lower bound of the search. Must be bounded by SpokePool deployment.
 * @param highBlocknumber Optional upper bound for the search.
 * @returns The block number at which the relay was completed, or undefined.
 */
export function findFillBlock(
  _spokePool: unknown,
  _relayData: RelayData,
  _lowBlockNumber: number,
  _highBlockNumber?: number
): Promise<number | undefined> {
  throw new Error("fillStatusArray: not implemented");
}

export function findFillEvent(
  _spokePool: unknown,
  _relayData: RelayData,
  _lowBlockNumber: number,
  _highBlockNumber?: number
): Promise<FillWithBlock | undefined> {
  throw new Error("fillStatusArray: not implemented");
}

/**
 * @param spokePool Address (program ID) of the SvmSpoke.
 * @param deposit V3Deopsit instance.
 * @param relayer Address of the relayer filling the deposit.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export async function fillRelayInstruction(
  spokePool: SvmAddress,
  deposit: Omit<Deposit, "messageHash">,
  relayer: TransactionSigner<string>,
  recipientTokenAccount: Address<string>,
  repaymentChainId = deposit.destinationChainId
) {
  const programId = spokePool.toBase58();
  const relayerAddress = SvmAddress.from(relayer.address);

  // @todo we need to convert the deposit's relayData to svm-like since the interface assumes the data originates from an EVM Spoke pool.
  // Once we migrate to `Address` types, this can be modified/removed.
  const {
    depositor: _depositor,
    recipient: _recipient,
    exclusiveRelayer: _exclusiveRelayer,
    inputToken: _inputToken,
    outputToken: _outputToken,
  } = deposit;
  const [depositor, recipient, exclusiveRelayer, inputToken, outputToken] = [
    _depositor,
    _recipient,
    _exclusiveRelayer,
    _inputToken,
    _outputToken,
  ].map((addr) => SvmAddress.from(addr));

  const _relayDataHash = getRelayDataHash(deposit, deposit.destinationChainId);
  const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

  // Create ATA for the relayer and recipient token accounts
  const relayerTokenAccount = await getAssociatedTokenAddress(relayerAddress.toV2Address(), outputToken.toV2Address());

  const { publicKey: statePda } = findProgramAddress("state", spokePool.toPublicKey(), ["0"]);
  const { publicKey: fillStatusPda } = findProgramAddress("fills", spokePool.toPublicKey(), [relayDataHash.toString()]);
  const { publicKey: eventAuthority } = findProgramAddress("__event_authority", spokePool.toPublicKey());

  return SvmSpokeClient.getFillRelayInstruction({
    signer: relayer,
    state: statePda.toBase58() as Address<string>,
    mint: outputToken.toV2Address(),
    relayerTokenAccount: relayerTokenAccount,
    recipientTokenAccount: recipientTokenAccount,
    fillStatus: fillStatusPda.toBase58() as Address<string>,
    eventAuthority: eventAuthority.toBase58() as Address<string>,
    program: programId as Address<string>,
    relayHash: relayDataHash,
    relayData: some({
      depositor: depositor.toV2Address(),
      recipient: recipient.toV2Address(),
      exclusiveRelayer: exclusiveRelayer.toV2Address(),
      inputToken: inputToken.toV2Address(),
      outputToken: outputToken.toV2Address(),
      inputAmount: deposit.inputAmount.toBigInt(),
      outputAmount: deposit.outputAmount.toBigInt(),
      originChainId: BigInt(deposit.originChainId),
      fillDeadline: deposit.fillDeadline,
      exclusivityDeadline: deposit.exclusivityDeadline,
      depositId: new Uint8Array(Buffer.from(deposit.depositId.toHexString().slice(2), "hex")),
      message: new Uint8Array(Buffer.from(deposit.message.slice(2), "hex")),
    }),
    repaymentChainId: some(repaymentChainId),
    repaymentAddress: some(relayerAddress.toV2Address()),
  });
}

/**
 * @param mint Address of the token corresponding to the account being made.
 * @param relayer Address of the relayer filling the deposit.
 * @returns An instruction for creating a new token account.
 */
export function createTokenAccountsInstruction(
  mint: SvmAddress,
  relayer: TransactionSigner<string>
): SvmSpokeClient.CreateTokenAccountsInstruction {
  return SvmSpokeClient.getCreateTokenAccountsInstruction({
    signer: relayer,
    mint: mint.toV2Address(),
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
  const relayerTokenAccount = await getAssociatedTokenAddress(
    relayer.toV2Address(),
    mint.toV2Address(),
    TOKEN_PROGRAM_ADDRESS
  );
  const { publicKey: statePda } = findProgramAddress("state", spokePool.toPublicKey(), ["0"]);
  const tokenInfo = getTokenInformationFromAddress(mint.toBase58());

  // FIXME: This will cause any bot to crash if the token being relayed is not in `TOKEN_SYMBOLS_MAP`, which is
  // going to break lots of integrations post-v4.
  if (!isDefined(tokenInfo)) {
    throw new Error(`${mint.toBase58()} is not a recognized token in TOKEN_SYMBOLS_MAP`);
  }

  const approveIx = await createApproveCheckedInstruction(
    SvmAddress.from(relayerTokenAccount as string).toPublicKey(),
    mint.toPublicKey(),
    statePda,
    relayer.toPublicKey(),
    BigInt(amount.toString()),
    tokenInfo!.decimals,
    undefined,
    TOKEN_PROGRAM_ID
  );
  return {
    ...approveIx,
    programAddress: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
  };
}

export async function getAssociatedTokenAddress(
  owner: Address<string>,
  mint: Address<string>,
  associatedTokenProgramId: Address<string> = TOKEN_PROGRAM_ADDRESS
): Promise<Address<string>> {
  const [associatedToken] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [owner, associatedTokenProgramId, mint],
  });
  return associatedToken;
}
