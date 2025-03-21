import assert from "assert";
import { BytesLike, Contract, PopulatedTransaction, providers, utils as ethersUtils } from "ethers";
import { CHAIN_IDs, MAX_SAFE_DEPOSIT_ID, UNDEFINED_MESSAGE_HASH, ZERO_ADDRESS, ZERO_BYTES } from "../constants";
import { Deposit, FillStatus, FillWithBlock, RelayData } from "../interfaces";
import { chunk } from "./ArrayUtils";
import { BigNumber, toBN } from "./BigNumberUtils";
import { keccak256 } from "./common";
import { isMessageEmpty } from "./DepositUtils";
import { isDefined } from "./TypeGuards";
import { getNetworkName } from "./NetworkUtils";
import { paginatedEventQuery, spreadEventWithBlockNumber } from "./EventUtils";
import { toBytes32 } from "./AddressUtils";

type BlockTag = providers.BlockTag;

/**
 * @param spokePool SpokePool Contract instance.
 * @param deposit V3Deopsit instance.
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function populateV3Relay(
  spokePool: Contract,
  deposit: Omit<Deposit, "messageHash">,
  relayer: string,
  repaymentChainId = deposit.destinationChainId
): Promise<PopulatedTransaction> {
  const v3RelayData: RelayData = {
    depositor: toBytes32(deposit.depositor),
    recipient: toBytes32(deposit.recipient),
    exclusiveRelayer: toBytes32(deposit.exclusiveRelayer),
    inputToken: toBytes32(deposit.inputToken),
    outputToken: toBytes32(deposit.outputToken),
    inputAmount: deposit.inputAmount,
    outputAmount: deposit.outputAmount,
    originChainId: deposit.originChainId,
    depositId: deposit.depositId,
    fillDeadline: deposit.fillDeadline,
    exclusivityDeadline: deposit.exclusivityDeadline,
    message: deposit.message,
  };
  if (isDefined(deposit.speedUpSignature)) {
    assert(isDefined(deposit.updatedRecipient) && !isZeroAddress(deposit.updatedRecipient));
    assert(isDefined(deposit.updatedOutputAmount));
    assert(isDefined(deposit.updatedMessage));
    return spokePool.populateTransaction.fillRelayWithUpdatedDeposit(
      v3RelayData,
      repaymentChainId,
      toBytes32(relayer),
      deposit.updatedOutputAmount,
      toBytes32(deposit.updatedRecipient),
      deposit.updatedMessage,
      deposit.speedUpSignature,
      { from: relayer }
    );
  }

  return spokePool.populateTransaction.fillRelay(v3RelayData, repaymentChainId, toBytes32(relayer), { from: relayer });
}

/**
 * Concatenate all fields from a Deposit, Fill or SlowFillRequest into a single string.
 * This can be used to identify a bridge event in a mapping. This is used instead of the actual keccak256 hash
 * (getRelayDataHash()) for two reasons: performance and the fact that only Deposit includes the `message` field, which
 * is required to compute a complete RelayData hash.
 * note: This function should _not_ be used to query the SpokePool.fillStatuses mapping.
 */
export function getRelayEventKey(
  data: Omit<RelayData, "message"> & { messageHash: string; destinationChainId: number }
): string {
  return [
    data.depositor,
    data.recipient,
    data.exclusiveRelayer,
    data.inputToken,
    data.outputToken,
    data.inputAmount,
    data.outputAmount,
    data.originChainId,
    data.destinationChainId,
    data.depositId,
    data.fillDeadline,
    data.exclusivityDeadline,
    data.messageHash,
  ]
    .map(String)
    .join("-");
}

const RELAYDATA_KEYS = [
  "depositId",
  "originChainId",
  "destinationChainId",
  "depositor",
  "recipient",
  "inputToken",
  "inputAmount",
  "outputToken",
  "outputAmount",
  "fillDeadline",
  "exclusivityDeadline",
  "exclusiveRelayer",
  "messageHash",
] as const;

// Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
// by the depositor as well as destinationToken, which are pulled from other clients.
export function validateFillForDeposit(
  relayData: Omit<RelayData, "message"> & { messageHash: string; destinationChainId: number },
  deposit?: Omit<Deposit, "quoteTimestamp" | "fromLiteChain" | "toLiteChain">
): { valid: true } | { valid: false; reason: string } {
  if (deposit === undefined) {
    return { valid: false, reason: "Deposit is undefined" };
  }

  // Note: this short circuits when a key is found where the comparison doesn't match.
  // TODO: if we turn on "strict" in the tsconfig, the elements of FILL_DEPOSIT_COMPARISON_KEYS will be automatically
  // validated against the fields in Fill and Deposit, generating an error if there is a discrepency.
  let invalidKey = RELAYDATA_KEYS.find((key) => relayData[key].toString() !== deposit[key].toString());

  // There should be no paths for `messageHash` to be unset, but mask it off anyway.
  if (!isDefined(invalidKey) && [relayData.messageHash, deposit.messageHash].includes(UNDEFINED_MESSAGE_HASH)) {
    invalidKey = "messageHash";
  }

  return isDefined(invalidKey)
    ? { valid: false, reason: `${invalidKey} mismatch (${relayData[invalidKey]} != ${deposit[invalidKey]})` }
    : { valid: true };
}

/**
 * Compute the RelayData hash for a fill. This can be used to determine the fill status.
 * @param relayData RelayData information that is used to complete a fill.
 * @param destinationChainId Supplementary destination chain ID required by V3 hashes.
 * @returns The corresponding RelayData hash.
 */
export function getRelayDataHash(relayData: RelayData, destinationChainId: number): string {
  const _relayData = {
    ...relayData,
    depositor: ethersUtils.hexZeroPad(relayData.depositor, 32),
    recipient: ethersUtils.hexZeroPad(relayData.recipient, 32),
    inputToken: ethersUtils.hexZeroPad(relayData.inputToken, 32),
    outputToken: ethersUtils.hexZeroPad(relayData.outputToken, 32),
    exclusiveRelayer: ethersUtils.hexZeroPad(relayData.exclusiveRelayer, 32),
  };
  return ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [
        "tuple(" +
          "bytes32 depositor," +
          "bytes32 recipient," +
          "bytes32 exclusiveRelayer," +
          "bytes32 inputToken," +
          "bytes32 outputToken," +
          "uint256 inputAmount," +
          "uint256 outputAmount," +
          "uint256 originChainId," +
          "uint256 depositId," +
          "uint32 fillDeadline," +
          "uint32 exclusivityDeadline," +
          "bytes message" +
          ")",
        "uint256 destinationChainId",
      ],
      [_relayData, destinationChainId]
    )
  );
}

export function getRelayHashFromEvent(e: RelayData & { destinationChainId: number }): string {
  return getRelayDataHash(e, e.destinationChainId);
}

export async function findDepositBlock(
  spokePool: Contract,
  depositId: BigNumber,
  lowBlock: number,
  highBlock?: number
): Promise<number | undefined> {
  // We can only perform this search when we have a safe deposit ID.
  if (isUnsafeDepositId(depositId)) {
    throw new Error(`Cannot binary search for depositId ${depositId}`);
  }

  highBlock ??= await spokePool.provider.getBlockNumber();
  assert(highBlock > lowBlock, `Block numbers out of range (${lowBlock} >= ${highBlock})`);

  // Make sure the deposit occurred within the block range supplied by the caller.
  const [nDepositsLow, nDepositsHigh] = (
    await Promise.all([
      spokePool.numberOfDeposits({ blockTag: lowBlock }),
      spokePool.numberOfDeposits({ blockTag: highBlock }),
    ])
  ).map((n) => toBN(n));

  if (nDepositsLow.gt(depositId) || nDepositsHigh.lte(depositId)) {
    return undefined; // Deposit did not occur within the specified block range.
  }

  // Find the lowest block number where numberOfDeposits is greater than the requested depositId.
  do {
    const midBlock = Math.floor((highBlock + lowBlock) / 2);
    const nDeposits = toBN(await spokePool.numberOfDeposits({ blockTag: midBlock }));

    if (nDeposits.gt(depositId)) {
      highBlock = midBlock; // depositId occurred at or earlier than midBlock.
    } else {
      lowBlock = midBlock + 1; // depositId occurred later than midBlock.
    }
  } while (lowBlock < highBlock);

  return lowBlock;
}

export function isUnsafeDepositId(depositId: BigNumber): boolean {
  // SpokePool.unsafeDepositV3() produces a uint256 depositId by hashing the msg.sender, depositor and input
  // uint256 depositNonce. There is a possibility that this resultant uint256 is less than the maxSafeDepositId (i.e.
  // the maximum uint32 value) which makes it possible that an unsafeDepositV3's depositId can collide with a safe
  // depositV3's depositId, but the chances of a collision are 1 in 2^(256 - 32), so we'll ignore this
  // possibility.
  const maxSafeDepositId = BigNumber.from(MAX_SAFE_DEPOSIT_ID);
  return maxSafeDepositId.lt(depositId);
}

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export async function relayFillStatus(
  spokePool: Contract,
  relayData: RelayData,
  blockTag?: number | "latest",
  destinationChainId?: number
): Promise<FillStatus> {
  destinationChainId ??= await spokePool.chainId();
  assert(isDefined(destinationChainId));

  const hash = getRelayDataHash(relayData, destinationChainId);
  const _fillStatus = await spokePool.fillStatuses(hash, { blockTag });
  const fillStatus = Number(_fillStatus);

  if (![FillStatus.Unfilled, FillStatus.RequestedSlowFill, FillStatus.Filled].includes(fillStatus)) {
    const { originChainId, depositId } = relayData;
    throw new Error(
      `relayFillStatus: Unexpected fillStatus for ${originChainId} deposit ${depositId.toString()} (${fillStatus})`
    );
  }

  return fillStatus;
}

export async function fillStatusArray(
  spokePool: Contract,
  relayData: RelayData[],
  blockTag: BlockTag = "latest"
): Promise<(FillStatus | undefined)[]> {
  const fillStatuses = "fillStatuses";
  const destinationChainId = await spokePool.chainId();

  const queries = relayData.map((relayData) => {
    const hash = getRelayDataHash(relayData, destinationChainId);
    return spokePool.interface.encodeFunctionData(fillStatuses, [hash]);
  });

  // Chunk the hashes into appropriate sizes to avoid death by rpc.
  const chunkSize = 250;
  const chunkedQueries = chunk(queries, chunkSize);

  const multicalls = await Promise.all(
    chunkedQueries.map((queries) => spokePool.callStatic.multicall(queries, { blockTag }))
  );
  const status = multicalls
    .map((multicall: BytesLike[]) =>
      multicall.map((result) => spokePool.interface.decodeFunctionResult(fillStatuses, result)[0])
    )
    .flat();

  const bnUnfilled = toBN(FillStatus.Unfilled);
  const bnFilled = toBN(FillStatus.Filled);

  return status.map((status: unknown) => {
    return BigNumber.isBigNumber(status) && status.gte(bnUnfilled) && status.lte(bnFilled)
      ? status.toNumber()
      : undefined;
  });
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
export async function findFillBlock(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<number | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} >= ${highBlockNumber})`);

  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query because the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await provider.getNetwork()).chainId
    : Number(await spokePool.chainId());
  assert(
    relayData.originChainId !== destinationChainId,
    `Origin & destination chain IDs must not be equal (${destinationChainId})`
  );

  // Make sure the relay was completed within the block range supplied by the caller.
  const [initialFillStatus, finalFillStatus] = (
    await Promise.all([
      relayFillStatus(spokePool, relayData, lowBlockNumber, destinationChainId),
      relayFillStatus(spokePool, relayData, highBlockNumber, destinationChainId),
    ])
  ).map(Number);

  if (finalFillStatus !== FillStatus.Filled) {
    return undefined; // Wasn't filled within the specified block range.
  }

  // Was filled earlier than the specified lowBlock. This is an error by the caller.
  if (initialFillStatus === FillStatus.Filled) {
    const { depositId, originChainId } = relayData;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    throw new Error(`${srcChain} deposit ${depositId.toString()} filled on ${dstChain} before block ${lowBlockNumber}`);
  }

  // Find the leftmost block where filledAmount equals the deposit amount.
  do {
    const midBlockNumber = Math.floor((highBlockNumber + lowBlockNumber) / 2);
    const fillStatus = await relayFillStatus(spokePool, relayData, midBlockNumber, destinationChainId);

    if (fillStatus === FillStatus.Filled) {
      highBlockNumber = midBlockNumber;
    } else {
      lowBlockNumber = midBlockNumber + 1;
    }
  } while (lowBlockNumber < highBlockNumber);

  return lowBlockNumber;
}

export async function findFillEvent(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<FillWithBlock | undefined> {
  const blockNumber = await findFillBlock(spokePool, relayData, lowBlockNumber, highBlockNumber);
  if (!blockNumber) return undefined;

  // We can hardcode this to 0 to instruct paginatedEventQuery to make a single request for the same block number.
  const maxBlockLookBack = 0;
  const [fromBlock, toBlock] = [blockNumber, blockNumber];

  const query = (
    await Promise.all([
      paginatedEventQuery(
        spokePool,
        spokePool.filters.FilledRelay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
        { fromBlock, toBlock, maxBlockLookBack }
      ),
      paginatedEventQuery(
        spokePool,
        spokePool.filters.FilledV3Relay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
        { fromBlock, toBlock, maxBlockLookBack }
      ),
    ])
  ).flat();
  if (query.length === 0) throw new Error(`Failed to find fill event at block ${blockNumber}`);
  const event = query[0];
  // In production the chainId returned from the provider matches 1:1 with the actual chainId. Querying the provider
  // object saves an RPC query because the chainId is cached by StaticJsonRpcProvider instances. In hre, the SpokePool
  // may be configured with a different chainId than what is returned by the provider.
  const destinationChainId = Object.values(CHAIN_IDs).includes(relayData.originChainId)
    ? (await spokePool.provider.getNetwork()).chainId
    : Number(await spokePool.chainId());
  const fill = {
    ...spreadEventWithBlockNumber(event),
    destinationChainId,
    messageHash: getMessageHash(event.args.message),
  } as FillWithBlock;
  return fill;
}

// Determines if the input address (either a bytes32 or bytes20) is the zero address.
export function isZeroAddress(address: string): boolean {
  return address === ZERO_ADDRESS || address === ZERO_BYTES;
}

export function getMessageHash(message: string): string {
  return isMessageEmpty(message) ? ZERO_BYTES : keccak256(message);
}
