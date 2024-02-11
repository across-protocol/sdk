import { BigNumber, Contract } from ".";
import {
  DepositWithBlock,
  Fill,
  FillStatus,
  FillType,
  RelayData,
  V2DepositWithBlock,
  V2Fill,
  V3DepositWithBlock,
  V3Fill,
  V3RelayData,
} from "../../src/interfaces";
import { assert } from "chai";
import {
  bnZero,
  getNetworkName,
  getRelayDataHash,
  getRelayDataOutputAmount,
  isV2Deposit,
  isV2RelayData,
} from "../../src/utils";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  return isV2Deposit(deposit) ? v2FillFromDeposit(deposit, relayer) : v3FillFromDeposit(deposit, relayer);
}

export function v2FillFromDeposit(deposit: V2DepositWithBlock, relayer: string): V2Fill {
  const { recipient, message, relayerFeePct } = deposit;

  const fill: Fill = {
    amount: deposit.amount,
    depositId: deposit.depositId,
    originChainId: deposit.originChainId,
    destinationChainId: deposit.destinationChainId,
    depositor: deposit.depositor,
    destinationToken: deposit.destinationToken,
    relayerFeePct: deposit.relayerFeePct,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    recipient,
    relayer,
    message,

    // Caller can modify these later.
    fillAmount: deposit.amount,
    totalFilledAmount: deposit.amount,
    repaymentChainId: deposit.destinationChainId,

    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      relayerFeePct: deposit.newRelayerFeePct ?? relayerFeePct,
      isSlowRelay: false,
      payoutAdjustmentPct: bnZero,
    },
  };

  return fill;
}

export function v3FillFromDeposit(deposit: V3DepositWithBlock, relayer: string): V3Fill {
  const { blockNumber, transactionHash, transactionIndex, ...partialDeposit } = deposit;
  const { recipient, message } = partialDeposit;

  const fill: V3Fill = {
    ...partialDeposit,
    relayer,

    // Caller can modify these later.
    exclusiveRelayer: relayer,
    repaymentChainId: deposit.destinationChainId,
    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      outputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export async function relayFilledAmount(
  spokePool: Contract,
  relayData: RelayData,
  blockTag?: number | "latest"
): Promise<BigNumber> {
  const hash = getRelayDataHash(relayData);

  if (isV2RelayData(relayData)) {
    const fills = await spokePool.queryFilter(
      await spokePool.filters.FilledRelay(
        null,
        null,
        null,
        null,
        relayData.originChainId,
        null,
        null,
        null,
        relayData.depositId,
        null,
        null,
        null,
        null,
        null,
        null
      )
    );
    // TODO: For this to be safe in production, you'd need to get the hash of the events
    // to match against `hash`, but since this is used in tests only we can just match on originChainId and depositId.
    if (fills.length === 0) return bnZero;
    if (blockTag === "latest") return fills[fills.length - 1].args?.totalFilledAmount;
    else {
      // Return latest totalFilled amount before blockTag which would be equivalent to the total filled amount
      // as of the block tag.
      return (
        fills.find((e) => {
          if (blockTag === undefined) return e.args?.totalFilledAmount;
          else if (e.blockNumber <= blockTag) return e.args?.totalFilledAmount;
        })?.args?.totalFilledAmount ?? bnZero
      );
    }
  }

  const fillStatus = await spokePool.fillStatuses(hash, { blockTag });

  // @note: If the deposit was updated then the fill amount may be _less_ than outputAmount.
  // @todo: Remove V3RelayData type assertion once RelayData type is unionised.
  return fillStatus === FillStatus.Filled ? (relayData as V3RelayData).outputAmount : bnZero;
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
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} > ${highBlockNumber})`);
  const { chainId: destinationChainId } = await provider.getNetwork();

  // Make sure the relay is 100% completed within the block range supplied by the caller.
  const [initialFillAmount, finalFillAmount] = await Promise.all([
    relayFilledAmount(spokePool, relayData, lowBlockNumber),
    relayFilledAmount(spokePool, relayData, highBlockNumber),
  ]);

  // Wasn't filled within the specified block range.
  const relayAmount = getRelayDataOutputAmount(relayData);
  if (finalFillAmount.lt(relayAmount)) {
    return undefined;
  }

  // Was filled earlier than the specified lowBlock.. This is an error by the caller.
  if (initialFillAmount.eq(relayAmount)) {
    const { depositId, originChainId } = relayData;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    throw new Error(`${srcChain} deposit ${depositId} filled on ${dstChain} before block ${lowBlockNumber}`);
  }

  // Find the leftmost block where filledAmount equals the deposit amount.
  do {
    const midBlockNumber = Math.floor((highBlockNumber + lowBlockNumber) / 2);
    const filledAmount = await relayFilledAmount(spokePool, relayData, midBlockNumber);

    if (filledAmount.eq(relayAmount)) {
      highBlockNumber = midBlockNumber;
    } else {
      lowBlockNumber = midBlockNumber + 1;
    }
  } while (lowBlockNumber < highBlockNumber);

  return lowBlockNumber;
}
