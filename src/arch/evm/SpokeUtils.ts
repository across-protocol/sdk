import assert from "assert";
import { BytesLike, Contract, PopulatedTransaction, providers } from "ethers";
import { CHAIN_IDs } from "../../constants";
import {
  Deposit,
  FillStatus,
  FillWithBlock,
  RelayData,
  RelayExecutionEventInfo,
  SpeedUpCommon,
} from "../../interfaces";
import {
  bnUint32Max,
  BigNumber,
  EvmAddress,
  toBN,
  bnZero,
  chunk,
  getMessageHash,
  getRelayDataHash,
  isDefined,
  isUnsafeDepositId,
  getNetworkName,
  paginatedEventQuery,
  spreadEventWithBlockNumber,
  Address,
  toAddressType,
} from "../../utils";

type BlockTag = providers.BlockTag;

type ProtoFill = Omit<RelayData, "recipient" | "outputToken"> &
  Pick<Deposit, "speedUpSignature"> &
  Partial<SpeedUpCommon> & {
    destinationChainId: number;
    recipient: EvmAddress;
    outputToken: EvmAddress;
  };

/**
 * @param spokePool SpokePool Contract instance.
 * @param relayData RelayData instance, supplemented with destinationChainId
 * @param repaymentChainId Optional repaymentChainId (defaults to destinationChainId).
 * @returns An Ethers UnsignedTransaction instance.
 */
export function populateV3Relay(
  spokePool: Contract,
  relayData: ProtoFill,
  repaymentAddress: Address,
  repaymentChainId = relayData.destinationChainId
): Promise<PopulatedTransaction> {
  assert(
    repaymentAddress.isValidOn(repaymentChainId),
    `Invalid repayment address for chain ${repaymentChainId}: ${repaymentAddress.toNative()}.`
  );
  const evmRelayData = {
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    inputAmount: relayData.inputAmount,
    outputAmount: relayData.outputAmount,
    originChainId: relayData.originChainId,
    depositId: relayData.depositId,
    fillDeadline: relayData.fillDeadline,
    exclusivityDeadline: relayData.exclusivityDeadline,
    message: relayData.message,
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };

  if (isDefined(relayData.speedUpSignature)) {
    assert(isDefined(relayData.updatedRecipient) && !relayData.updatedRecipient.isZeroAddress());
    assert(isDefined(relayData.updatedOutputAmount));
    assert(isDefined(relayData.updatedMessage));
    return spokePool.populateTransaction.fillRelayWithUpdatedDeposit(
      relayData,
      repaymentChainId,
      repaymentAddress.toBytes32(),
      relayData.updatedOutputAmount,
      relayData.updatedRecipient.toBytes32(),
      relayData.updatedMessage,
      relayData.speedUpSignature
    );
  }

  return spokePool.populateTransaction.fillRelay(evmRelayData, repaymentChainId, repaymentAddress.toBytes32());
}

/**
 * Retrieves the time from the SpokePool contract at a particular block.
 * @returns The time at the specified block tag.
 */
export async function getTimeAt(spokePool: Contract, blockNumber: number): Promise<number> {
  const currentTime = await spokePool.getCurrentTime({ blockTag: blockNumber });
  assert(BigNumber.isBigNumber(currentTime) && currentTime.lt(bnUint32Max));
  return currentTime.toNumber();
}

/**
 * Retrieves the chain time at a particular block.
 * @note This should be the same as getTimeAt() but can differ in test. These two functions should be consolidated.
 * @returns The chain time at the specified block tag.
 */
export async function getTimestampForBlock(provider: providers.Provider, blockNumber: number): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  return block.timestamp;
}

/**
 * Return maximum of fill deadline buffer at start and end of block range.
 * @param spokePool SpokePool contract instance
 * @param startBlock start block
 * @param endBlock end block
 * @returns maximum of fill deadline buffer at start and end block
 */
export async function getMaxFillDeadlineInRange(
  spokePool: Contract,
  startBlock: number,
  endBlock: number
): Promise<number> {
  const fillDeadlineBuffers = await Promise.all([
    spokePool.fillDeadlineBuffer({ blockTag: startBlock }),
    spokePool.fillDeadlineBuffer({ blockTag: endBlock }),
  ]);
  return Math.max(fillDeadlineBuffers[0], fillDeadlineBuffers[1]);
}

/**
 * Finds the deposit id at a specific block number.
 * @param blockTag The block number to search for the deposit ID at.
 * @returns The deposit ID.
 */
export async function getDepositIdAtBlock(contract: Contract, blockTag: number): Promise<BigNumber> {
  const _depositIdAtBlock = await contract.numberOfDeposits({ blockTag });
  const depositIdAtBlock = toBN(_depositIdAtBlock);
  // Sanity check to ensure that the deposit ID is greater than or equal to zero.
  if (depositIdAtBlock.lt(bnZero)) {
    throw new Error("Invalid deposit count");
  }
  return depositIdAtBlock;
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
  blockTag: BlockTag = "latest",
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
  const maxLookBack = 0;
  const [from, to] = [blockNumber, blockNumber];

  const query = (
    await Promise.all([
      paginatedEventQuery(
        spokePool,
        spokePool.filters.FilledRelay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
        { from, to, maxLookBack }
      ),
      paginatedEventQuery(
        spokePool,
        spokePool.filters.FilledV3Relay(null, null, null, null, null, relayData.originChainId, relayData.depositId),
        { from, to, maxLookBack }
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
  const fillEvent = spreadEventWithBlockNumber(event) as FillWithBlock & {
    depositor: string;
    recipient: string;
    inputToken: string;
    outputToken: string;
    exclusiveRelayer: string;
    relayer: string;
    relayExecutionInfo: RelayExecutionEventInfo & { updatedRecipient: string };
  };
  const fill = {
    ...fillEvent,
    inputToken: toAddressType(fillEvent.inputToken, relayData.originChainId),
    outputToken: toAddressType(fillEvent.outputToken, destinationChainId),
    depositor: toAddressType(fillEvent.depositor, relayData.originChainId),
    recipient: toAddressType(fillEvent.recipient, destinationChainId),
    exclusiveRelayer: toAddressType(fillEvent.exclusiveRelayer, destinationChainId),
    relayer: toAddressType(fillEvent.relayer, destinationChainId),
    relayExecutionInfo: {
      ...fillEvent.relayExecutionInfo,
      updatedRecipient: toAddressType(fillEvent.relayExecutionInfo.updatedRecipient, destinationChainId),
    },
    destinationChainId,
    messageHash: getMessageHash(event.args.message),
  } as FillWithBlock;
  return fill;
}
