import assert from "assert";
import { Contract } from "ethers";
import { random } from "lodash";
import winston from "winston";
import { EMPTY_MESSAGE, ZERO_ADDRESS, ZERO_BYTES } from "../../constants";
import {
  Log,
  Deposit,
  DepositWithBlock,
  FillType,
  RelayerRefundExecution,
  SlowFillRequest,
  SortableEvent,
  Fill,
  SlowFillLeaf,
  SpeedUp,
  TokensBridged,
} from "../../interfaces";
import {
  toBN,
  toBNWei,
  getCurrentTime,
  getMessageHash,
  randomAddress,
  BigNumber,
  bnZero,
  bnOne,
  toBytes32,
  spreadEventWithBlockNumber,
  Address,
  toAddressType,
  isDefined,
} from "../../utils";
import { EVMSpokePoolClient, SpokePoolUpdate } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { EventManager, EventOverrides, getEventManager } from "./MockEvents";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";

// This class replaces internal SpokePoolClient functionality, enabling
// the user to bypass on-chain queries and inject Log objects directly.
export class MockSpokePoolClient extends EVMSpokePoolClient {
  public eventManager: EventManager;
  private destinationTokenForChainOverride: Record<number, string> = {};
  // Allow tester to set the numberOfDeposits() returned by SpokePool at a block height.
  public depositIdAtBlock: BigNumber[] = [];
  public numberOfDeposits = bnZero;

  constructor(
    logger: winston.Logger,
    spokePool: Contract,
    chainId: number,
    deploymentBlock: number,
    opts: { hubPoolClient: HubPoolClient | null } = { hubPoolClient: null }
  ) {
    super(logger, spokePool, opts.hubPoolClient, chainId, deploymentBlock);
    this.latestHeightSearched = deploymentBlock;
    this.eventManager = getEventManager(chainId, this.eventSignatures, deploymentBlock);
  }

  setConfigStoreClient(configStore?: AcrossConfigStoreClient): void {
    this.configStoreClient = configStore;
  }

  setDestinationTokenForChain(chainId: number, token: string): void {
    this.destinationTokenForChainOverride[chainId] = token;
  }

  getDestinationTokenForDeposit(deposit: DepositWithBlock): Address {
    const override = this.destinationTokenForChainOverride[deposit.originChainId];
    return isDefined(override)
      ? toAddressType(override, deposit.destinationChainId)
      : super.getDestinationTokenForDeposit(deposit);
  }

  setLatestBlockNumber(blockNumber: number): void {
    this.latestHeightSearched = blockNumber;
  }

  setDepositIds(_depositIds: BigNumber[]): void {
    this.depositIdAtBlock = [];
    if (_depositIds.length === 0) {
      return;
    }
    let lastDepositId = _depositIds[0];
    for (let i = 0; i < _depositIds.length; i++) {
      if (_depositIds[i].lt(lastDepositId)) {
        throw new Error("deposit ID must be equal to or greater than previous");
      }
      this.depositIdAtBlock[i] = _depositIds[i];
      lastDepositId = _depositIds[i];
    }
  }

  _getDepositIdAtBlock(blockTag: number): Promise<BigNumber> {
    return Promise.resolve(this.depositIdAtBlock[blockTag]);
  }

  _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Generate new "on chain" responses.
    const latestBlockSearched = this.eventManager.blockNumber;
    const currentTime = getCurrentTime();

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const events: Log[][] = eventsToQuery.map(() => []);
    this.eventManager
      .getEvents()
      .flat()
      .forEach((event) => {
        const idx = eventsToQuery.indexOf(event.event);
        if (idx !== -1) {
          events[idx].push(event);
        }
      });

    const eventsWithBlockNumber = events.map((eventList) =>
      eventList.map((event) => spreadEventWithBlockNumber(event))
    );

    return Promise.resolve({
      success: true,
      firstDepositId: bnZero,
      currentTime,
      events: eventsWithBlockNumber,
      searchEndBlock: this.eventSearchConfig.to || latestBlockSearched,
    });
  }

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    EnabledDepositRoute: "address,uint256,bool",
  };

  deposit(deposit: Omit<Deposit, "messageHash"> & Partial<SortableEvent>): Log {
    return this._deposit("FundsDeposited", deposit);
  }

  protected _deposit(
    event: string,
    deposit: Omit<Deposit, "messageHash"> & { message?: string } & Partial<SortableEvent>
  ): Log {
    const { blockNumber, txnIndex } = deposit;
    let { depositId, destinationChainId, inputAmount, outputAmount } = deposit;
    depositId ??= this.numberOfDeposits;
    this.numberOfDeposits = depositId.add(bnOne);

    destinationChainId ??= random(1, 42161, false);
    const depositor = deposit.depositor?.toBytes32() ?? toBytes32(randomAddress());
    const recipient = deposit.recipient?.toBytes32() ?? toBytes32(depositor);
    const inputToken = deposit.inputToken?.toBytes32() ?? toBytes32(randomAddress());
    const outputToken = deposit.outputToken?.toBytes32() ?? inputToken;
    const exclusiveRelayer = deposit.exclusiveRelayer?.toBytes32() ?? toBytes32(ZERO_ADDRESS);

    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount.mul(toBN("0.95"));

    const message = deposit.message ?? "0x";
    const topics = [destinationChainId, depositId, depositor];
    const quoteTimestamp = deposit.quoteTimestamp ?? getCurrentTime();
    const args = {
      depositId,
      originChainId: deposit.originChainId ?? this.chainId,
      destinationChainId,
      depositor,
      recipient,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      quoteTimestamp,
      fillDeadline: deposit.fillDeadline ?? quoteTimestamp + 3600,
      exclusiveRelayer,
      exclusivityDeadline: deposit.exclusivityDeadline ?? quoteTimestamp + 600,
      message,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex: txnIndex,
    });
  }

  fillRelay(fill: Omit<Fill, "messageHash"> & { message?: string } & Partial<SortableEvent>): Log {
    return this._fillRelay("FilledRelay", fill);
  }

  protected _fillRelay(
    event: string,
    fill: Omit<Fill, "messageHash"> & { message?: string } & Partial<SortableEvent>
  ): Log {
    const { blockNumber, txnIndex } = fill;
    let { originChainId, depositId, inputAmount, outputAmount, fillDeadline } = fill;
    originChainId ??= random(1, 42161, false);
    depositId ??= BigNumber.from(random(1, 100_000, false));
    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount;
    fillDeadline ??= getCurrentTime() + 60;

    const depositor = fill.depositor?.toBytes32() ?? toBytes32(randomAddress());
    const recipient = fill.recipient?.toBytes32() ?? toBytes32(depositor);
    const inputToken = fill.inputToken?.toBytes32() ?? toBytes32(randomAddress());
    const outputToken = fill.outputToken?.toBytes32() ?? toBytes32(ZERO_ADDRESS);
    const exclusiveRelayer = fill.exclusiveRelayer?.toBytes32() ?? toBytes32(ZERO_ADDRESS);
    const relayer = fill.relayer?.toBytes32() ?? toBytes32(randomAddress());

    const topics = [originChainId, depositId, relayer];
    const message = fill.message ?? EMPTY_MESSAGE;
    const updatedMessage = fill.relayExecutionInfo?.updatedMessage ?? message;
    const updatedRecipient = fill.relayExecutionInfo?.updatedRecipient.toBytes32() ?? recipient;

    const relayExecutionInfo = {
      updatedRecipient,
      updatedOutputAmount: fill.relayExecutionInfo?.updatedOutputAmount ?? outputAmount,
      fillType: fill.relayExecutionInfo?.fillType ?? FillType.FastFill,
    };

    const _args = {
      inputToken,
      outputToken,
      inputAmount: fill.inputAmount,
      outputAmount: fill.outputAmount,
      repaymentChainId: fill.repaymentChainId ?? this.chainId,
      originChainId,
      depositId,
      fillDeadline,
      exclusivityDeadline: fill.exclusivityDeadline ?? fillDeadline,
      exclusiveRelayer,
      relayer,
      depositor,
      recipient,
      relayExecutionInfo: {
        updatedRecipient,
        updatedOutputAmount: fill.relayExecutionInfo?.updatedOutputAmount ?? outputAmount,
        fillType: fill.relayExecutionInfo?.fillType ?? FillType.FastFill,
      },
    };

    const args = {
      ..._args,
      messageHash: getMessageHash(message),
      relayExecutionInfo: {
        ...relayExecutionInfo,
        updatedMessageHash: getMessageHash(updatedMessage),
      },
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex: txnIndex,
    });
  }

  speedUpDeposit(speedUp: SpeedUp): Log {
    return this._speedUpDeposit("RequestedSpeedUpDeposit", speedUp);
  }

  protected _speedUpDeposit(event: string, speedUp: SpeedUp): Log {
    const depositor = speedUp.depositor.toBytes32();
    const topics = [speedUp.depositId, depositor];
    const args = { ...speedUp };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args: {
        ...args,
        depositor,
        updatedRecipient: speedUp.updatedRecipient.toBytes32(),
      },
    });
  }

  setTokensBridged(tokensBridged: Omit<TokensBridged, "l2TokenAddress"> & { l2TokenAddress: string }): Log {
    const event = "TokensBridged";
    const topics = [tokensBridged.chainId, tokensBridged.leafId, tokensBridged.l2TokenAddress];
    const args = { ...tokensBridged };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
    });
  }

  requestSlowFill(request: Omit<SlowFillRequest, "destinationChainId"> & Partial<SortableEvent>): Log {
    return this._requestSlowFill("RequestedSlowFill", request);
  }

  protected _requestSlowFill(
    event: string,
    request: Omit<SlowFillRequest, "destinationChainId"> & Partial<SortableEvent>
  ): Log {
    const { originChainId, depositId } = request;
    const topics = [originChainId, depositId];
    const args = { ...request };

    const depositor = args.depositor.toBytes32() ?? toBytes32(randomAddress());

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args: {
        ...args,
        destinationChainId: this.chainId,
        depositor,
        recipient: args.recipient?.toBytes32() ?? depositor,
        inputToken: args.inputToken?.toBytes32() ?? toBytes32(randomAddress()),
        outputToken: args.outputToken?.toBytes32() ?? toBytes32(ZERO_ADDRESS),
        exclusiveRelayer: args.exclusiveRelayer?.toBytes32() ?? toBytes32(ZERO_ADDRESS),
        messageHash: args.messageHash ?? ZERO_BYTES,
      },
      blockNumber: request.blockNumber,
      transactionIndex: request.txnIndex,
    });
  }

  // This is a simple wrapper around fillRelay().
  // rootBundleId and proof are discarded here - we have no interest in verifying that.
  executeSlowRelayLeaf(leaf: Omit<SlowFillLeaf, "messageHash">): Log {
    const destinationChainId = this.chainId;
    const fill = {
      ...leaf.relayData,
      destinationChainId,
      relayer: toAddressType(ZERO_ADDRESS, destinationChainId),
      repaymentChainId: 0,
      relayExecutionInfo: {
        updatedRecipient: leaf.relayData.recipient,
        updatedOutputAmount: leaf.updatedOutputAmount,
        updatedMessage: leaf.relayData.message,
        updatedMessageHash: getMessageHash(leaf.relayData.message),
        fillType: FillType.SlowFill,
      },
    };

    return this.fillRelay(fill);
  }

  executeRelayerRefundLeaf(refund: RelayerRefundExecution & Partial<SortableEvent>): Log {
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
  ): Log {
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
