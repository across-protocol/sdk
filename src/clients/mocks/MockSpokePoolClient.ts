import assert from "assert";
import { BigNumber, Contract, Event, providers } from "ethers";
import { random } from "lodash";
import winston from "winston";
import { ZERO_ADDRESS } from "../../constants";
import {
  DepositWithBlock,
  FillType,
  FundsDepositedEvent,
  RealizedLpFee,
  RelayerRefundExecutionWithBlock,
  SlowFillRequestWithBlock,
  V2DepositWithBlock,
  V2FillWithBlock,
  V2SpeedUp,
  V3DepositWithBlock,
  V3Fill,
  V3FillWithBlock,
  V3SlowFillLeaf,
  V3SpeedUp,
} from "../../interfaces";
import {
  bnZero,
  toBN,
  toBNWei,
  forEachAsync,
  getCurrentTime,
  isV2Deposit,
  isV2Fill,
  isV3Deposit,
  isV3Fill,
  randomAddress,
} from "../../utils";
import { SpokePoolClient, SpokePoolUpdate } from "../SpokePoolClient";
import { EventManager, EventOverrides, getEventManager } from "./MockEvents";

type Block = providers.Block;

// This class replaces internal SpokePoolClient functionality, enabling the
// user to bypass on-chain queries and inject ethers Event objects directly.
export class MockSpokePoolClient extends SpokePoolClient {
  public eventManager: EventManager;
  private realizedLpFeePct: BigNumber = bnZero;
  private realizedLpFeePctOverride = false;
  private destinationTokenForChainOverride: Record<number, string> = {};
  // Allow tester to set the numberOfDeposits() returned by SpokePool at a block height.
  public depositIdAtBlock: number[] = [];
  public numberOfDeposits = 0;
  public blocks: Record<number, Block> = {};

  constructor(logger: winston.Logger, spokePool: Contract, chainId: number, deploymentBlock: number) {
    super(logger, spokePool, null, chainId, deploymentBlock);
    this.latestBlockSearched = deploymentBlock;
    this.eventManager = getEventManager(chainId, this.eventSignatures, deploymentBlock);
  }

  setDefaultRealizedLpFeePct(fee: BigNumber): void {
    this.realizedLpFeePct = fee;
    this.realizedLpFeePctOverride = true;
  }

  clearDefaultRealizedLpFeePct(): void {
    this.realizedLpFeePctOverride = false;
  }

  async computeRealizedLpFeePct(depositEvent: FundsDepositedEvent) {
    const { realizedLpFeePct, realizedLpFeePctOverride } = this;
    const { blockNumber: quoteBlock } = depositEvent;
    return realizedLpFeePctOverride
      ? { realizedLpFeePct, quoteBlock }
      : await super.computeRealizedLpFeePct(depositEvent);
  }

  async batchComputeRealizedLpFeePct(depositEvents: FundsDepositedEvent[]): Promise<RealizedLpFee[]> {
    const { realizedLpFeePct, realizedLpFeePctOverride } = this;
    return realizedLpFeePctOverride
      ? depositEvents.map(({ blockNumber: quoteBlock }) => {
          return { realizedLpFeePct, quoteBlock };
        })
      : await super.batchComputeRealizedLpFeePct(depositEvents);
  }

  setDestinationTokenForChain(chainId: number, token: string): void {
    this.destinationTokenForChainOverride[chainId] = token;
  }

  getDestinationTokenForDeposit(deposit: DepositWithBlock): string {
    return this.destinationTokenForChainOverride[deposit.originChainId] ?? super.getDestinationTokenForDeposit(deposit);
  }

  setLatestBlockNumber(blockNumber: number): void {
    this.latestBlockSearched = blockNumber;
  }

  setDepositIds(_depositIds: number[]): void {
    this.depositIdAtBlock = [];
    if (_depositIds.length === 0) {
      return;
    }
    let lastDepositId = _depositIds[0];
    for (let i = 0; i < _depositIds.length; i++) {
      if (_depositIds[i] < lastDepositId) {
        throw new Error("deposit ID must be equal to or greater than previous");
      }
      this.depositIdAtBlock[i] = _depositIds[i];
      lastDepositId = _depositIds[i];
    }
  }
  _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return Promise.resolve(this.depositIdAtBlock[blockTag]);
  }

  async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Generate new "on chain" responses.
    const latestBlockSearched = this.eventManager.blockNumber;
    const currentTime = getCurrentTime();

    const blocks: { [blockNumber: number]: Block } = {};

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const events: Event[][] = eventsToQuery.map(() => []);
    await forEachAsync(this.eventManager.getEvents().flat(), async (event) => {
      const idx = eventsToQuery.indexOf(event.event as string);
      if (idx !== -1) {
        events[idx].push(event);
        blocks[event.blockNumber] = await event.getBlock();
      }
    });
    this.blocks = blocks;

    // Update latestDepositIdQueried.
    const idx = eventsToQuery.indexOf("FundsDeposited");
    const latestDepositId = (events[idx] ?? []).reduce(
      (depositId, event) => Math.max(depositId, event.args?.["depositId"] ?? 0),
      this.latestDepositIdQueried
    );

    return {
      success: true,
      firstDepositId: 0,
      latestDepositId,
      currentTime,
      oldestTime: 0,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockSearched,
    };
  }

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    EnabledDepositRoute: "address,uint256,bool",
    FilledRelay: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
    FundsDeposited: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
  };

  deposit(deposit: V2DepositWithBlock): Event {
    assert(isV2Deposit(deposit));
    const event = "FundsDeposited";

    const { blockNumber, transactionIndex } = deposit;
    let { depositId, depositor, destinationChainId } = deposit;
    depositId ??= this.numberOfDeposits;
    assert(depositId >= this.numberOfDeposits, `${depositId} < ${this.numberOfDeposits}`);
    this.numberOfDeposits = depositId + 1;

    destinationChainId ??= random(1, 42161, false);
    depositor ??= randomAddress();

    const message = deposit["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;
    const topics = [destinationChainId, depositId, depositor];
    const args = {
      amount: deposit.amount ?? toBNWei(random(1, 1000, false)),
      originChainId: deposit.originChainId ?? this.chainId,
      destinationChainId,
      relayerFeePct: deposit.relayerFeePct ?? toBNWei(0.0001),
      depositId,
      quoteTimestamp: deposit.quoteTimestamp ?? getCurrentTime(),
      originToken: deposit.originToken ?? randomAddress(),
      recipient: deposit.recipient ?? depositor,
      depositor,
      message,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  depositV3(deposit: V3DepositWithBlock): Event {
    assert(isV3Deposit(deposit));
    const event = "V3FundsDeposited";

    const { blockNumber, transactionIndex } = deposit;
    let { depositId, depositor, destinationChainId, inputToken, inputAmount, outputToken, outputAmount } = deposit;
    depositId ??= this.numberOfDeposits;
    assert(depositId >= this.numberOfDeposits, `${depositId} < ${this.numberOfDeposits}`);
    this.numberOfDeposits = depositId + 1;

    destinationChainId ??= random(1, 42161, false);
    depositor ??= randomAddress();
    inputToken ??= randomAddress();
    outputToken ??= inputToken;
    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount.mul(toBN("0.95"));

    const message = deposit["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;
    const topics = [destinationChainId, depositId, depositor];
    const quoteTimestamp = deposit.quoteTimestamp ?? getCurrentTime();
    const args = {
      depositId,
      originChainId: deposit.originChainId ?? this.chainId,
      destinationChainId,
      depositor,
      recipient: deposit.recipient ?? depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      quoteTimestamp,
      fillDeadline: deposit.fillDeadline ?? quoteTimestamp + 3600,
      exclusiveRelayer: deposit.exclusiveRelayer ?? ZERO_ADDRESS,
      exclusivityDeadline: deposit.exclusivityDeadline ?? quoteTimestamp + 600,
      message,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  fillRelay(fill: V2FillWithBlock): Event {
    assert(isV2Fill(fill));
    const event = "FilledRelay";

    const { blockNumber, transactionIndex } = fill;
    let { depositor, originChainId, depositId } = fill;
    originChainId ??= random(1, 42161, false);
    depositId ??= random(1, 100_000, false);
    depositor ??= randomAddress();

    const topics = [originChainId, depositId, depositor];
    const recipient = fill.recipient ?? randomAddress();
    const amount = fill.amount ?? toBNWei(random(1, 1000, false));
    const relayerFeePct = fill.relayerFeePct ?? toBNWei(0.0001);
    const message = fill["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;

    const args = {
      amount,
      totalFilledAmount: fill.totalFilledAmount ?? amount,
      fillAmount: fill.fillAmount ?? amount,
      repaymentChainId: fill.repaymentChainId ?? this.chainId,
      originChainId,
      destinationChainId: fill.destinationChainId,
      realizedLpFeePct: fill.realizedLpFeePct ?? toBNWei(random(0.00001, 0.0001).toPrecision(6)),
      relayerFeePct,
      depositId,
      destinationToken: fill.destinationToken ?? ZERO_ADDRESS, // resolved via HubPoolClient.
      relayer: fill.relayer ?? randomAddress(),
      depositor,
      recipient,
      message,
      updatableRelayData: {
        updatableRecipient: fill.updatableRelayData?.updatedRecipient ?? recipient,
        updatableMessage: fill.updatableRelayData?.updatedMessage ?? message,
        updatedRelayerFeePct: fill.updatableRelayData?.relayerFeePct ?? relayerFeePct,
        isSlowRelay: fill.updatableRelayData?.isSlowRelay ?? false,
        payoutAdjustmentPct: fill.updatableRelayData?.payoutAdjustmentPct ?? bnZero,
      },
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  fillV3Relay(fill: V3FillWithBlock): Event {
    assert(isV3Fill(fill));
    const event = "FilledV3Relay";

    const { blockNumber, transactionIndex } = fill;
    let { originChainId, depositId, inputToken, inputAmount, outputAmount, fillDeadline, relayer } = fill;
    originChainId ??= random(1, 42161, false);
    depositId ??= random(1, 100_000, false);
    inputToken ??= randomAddress();
    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount;
    fillDeadline ??= getCurrentTime() + 60;
    relayer ??= randomAddress();

    const topics = [originChainId, depositId, relayer];
    const recipient = fill.recipient ?? randomAddress();
    const message = fill["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;

    const args = {
      inputToken,
      outputToken: fill.outputToken ?? ZERO_ADDRESS, // resolved via HubPoolClient.
      inputAmount: fill.inputAmount,
      outputAmount: fill.outputAmount,
      repaymentChainId: fill.repaymentChainId ?? this.chainId,
      originChainId,
      depositId,
      fillDeadline,
      exclusivityDeadline: fill.exclusivityDeadline ?? fillDeadline,
      exclusiveRelayer: fill.exclusiveRelayer ?? ZERO_ADDRESS,
      relayer,
      depositor: fill.depositor ?? randomAddress(),
      recipient,
      message,
      relayExecutionInfo: {
        updatedRecipient: fill.relayExecutionInfo?.updatedRecipient ?? recipient,
        updatedMessage: fill.relayExecutionInfo?.updatedMessage ?? message,
        updatedOutputAmount: fill.relayExecutionInfo?.updatedOutputAmount ?? outputAmount,
        fillType: fill.relayExecutionInfo?.fillType ?? FillType.FastFill,
      },
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  speedUpDeposit(speedUp: V2SpeedUp): Event {
    const event = "RequestedSpeedUpDeposit";
    const topics = [speedUp.depositId, speedUp.depositor];
    const args = { ...speedUp };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
    });
  }

  speedUpV3Deposit(speedUp: V3SpeedUp): Event {
    const event = "RequestedSpeedUpV3Deposit";
    const topics = [speedUp.depositId, speedUp.depositor];
    const args = { ...speedUp };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
    });
  }

  requestV3SlowFill(request: SlowFillRequestWithBlock): Event {
    const event = "RequestedV3SlowFill";

    const { originChainId, depositId } = request;
    const topics = [originChainId, depositId];
    const args = { ...request };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: request.blockNumber,
      transactionIndex: request.transactionIndex,
    });
  }

  // This is a simple wrapper around fillV3Relay().
  // rootBundleId and proof are discarded here - we have no interest in verifying that.
  executeV3SlowRelayLeaf(leaf: V3SlowFillLeaf): Event {
    const fill: V3Fill = {
      ...leaf.relayData,
      destinationChainId: this.chainId,
      relayer: ZERO_ADDRESS,
      repaymentChainId: 0,
      relayExecutionInfo: {
        updatedRecipient: leaf.relayData.recipient,
        updatedOutputAmount: leaf.updatedOutputAmount,
        updatedMessage: leaf.relayData.message,
        fillType: FillType.SlowFill,
      },
    };

    return this.fillV3Relay(fill as V3FillWithBlock);
  }

  executeRelayerRefundLeaf(refund: RelayerRefundExecutionWithBlock): Event {
    const event = "ExecutedRelayerRefundRoot";

    const chainId = refund.chainId ?? this.chainId;
    assert(chainId === this.chainId);

    const { rootBundleId, leafId } = refund;
    const topics = [chainId, rootBundleId, leafId];
    const args = {
      chainId,
      rootBundleId,
      leafId,
      amountToReturn: refund.amountToReturn,
      l2TokenAddress: refund.l2TokenAddress,
      refundAddresses: refund.refundAddresses,
      refundAmounts: refund.refundAmounts,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: refund.blockNumber,
    });
  }

  setEnableRoute(
    originToken: string,
    destinationChainId: number,
    enabled: boolean,
    overrides: EventOverrides = {}
  ): Event {
    const event = "EnabledDepositRoute";

    const topics = [originToken, destinationChainId];
    const args = { originToken, destinationChainId, enabled };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: overrides.blockNumber,
    });
  }
}
