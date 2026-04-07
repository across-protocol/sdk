import {
  findDepositBlock,
  getMaxFillDeadlineInRange as getMaxFillDeadline,
  getTimeAt as _getTimeAt,
  relayFillStatus,
} from "../../arch/tvm";
import { FillStatus, RelayData } from "../../interfaces";
import { BigNumber } from "../../utils";
import { EVMSpokePoolClient } from "./EVMSpokePoolClient";
import { TVM_SPOKE_POOL_CLIENT_TYPE } from "./types";

/**
 * A TVM-specific SpokePoolClient for TRON.
 *
 * TRON is EVM-compatible for reads and event queries, but diverges in three areas:
 * 1. No historical `eth_call` — only "latest" blockTag is accepted.
 * 2. No `eth_sendRawTransaction` — TRON uses Protobuf-encoded transactions via TronWeb.
 * 3. Energy/bandwidth fee model instead of gas.
 *
 * This client extends EVMSpokePoolClient, overriding only the methods affected by (1).
 * Transaction submission (2) and fee estimation (3) are handled by the arch/tvm utilities.
 */
export class TVMSpokePoolClient extends EVMSpokePoolClient {
  // @ts-expect-error: Narrowing the base class literal type from "EVM" to "TVM".
  override readonly type = TVM_SPOKE_POOL_CLIENT_TYPE;

  public override relayFillStatus(relayData: RelayData, atHeight?: number): Promise<FillStatus> {
    return relayFillStatus(this.spokePool, relayData, atHeight, this.chainId);
  }

  public override getMaxFillDeadlineInRange(startBlock: number, endBlock: number): Promise<number> {
    return getMaxFillDeadline(this.spokePool, startBlock, endBlock);
  }

  public override getTimeAt(blockNumber: number): Promise<number> {
    return _getTimeAt(this.spokePool, blockNumber);
  }

  /**
   * Override to use TVM's event-based findDepositBlock
   * instead of EVM's binary-search over historical numberOfDeposits().
   */
  protected override _findDepositBlock(
    depositId: BigNumber,
    lowBlock: number,
    highBlock?: number
  ): Promise<number | undefined> {
    return findDepositBlock(this.spokePool, depositId, lowBlock, highBlock);
  }

  /**
   * Override to avoid historical eth_call for getCurrentTime.
   * TRON does not support eth_call with historical blockTags, so we
   * use the block timestamp from provider.getBlock() instead of
   * SpokePool.getCurrentTime({ blockTag }).
   */
  protected override async _getCurrentTime(blockNumber: number): Promise<number> {
    const block = await this.spokePool.provider.getBlock(blockNumber);
    const currentTime = block.timestamp;
    if (currentTime < this.currentTime) {
      throw new Error(`TVMSpokePoolClient::update: currentTime: ${currentTime} < ${this.currentTime}`);
    }
    return currentTime;
  }
}
