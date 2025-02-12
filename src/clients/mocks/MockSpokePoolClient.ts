import assert from "assert";
import { Contract } from "ethers";
import { random } from "lodash";
import winston from "winston";
import { EMPTY_MESSAGE, ZERO_ADDRESS } from "../../constants";
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
  bnMax,
  bnOne,
  toAddress,
  toBytes32,
} from "../../utils";
import { SpokePoolClient, SpokePoolUpdate } from "../SpokePoolClient";
import { HubPoolClient } from "../HubPoolClient";
import { EventManager, EventOverrides, getEventManager } from "./MockEvents";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";

// This class replaces internal SpokePoolClient functionality, enabling
// the user to bypass on-chain queries and inject Log objects directly.
export class MockSpokePoolClient extends SpokePoolClient {
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
    this.latestBlockSearched = deploymentBlock;
    this.eventManager = getEventManager(chainId, this.eventSignatures, deploymentBlock);
  }

  setConfigStoreClient(configStore?: AcrossConfigStoreClient): void {
    this.configStoreClient = configStore;
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

    // Update latestDepositIdQueried.
    const idx = eventsToQuery.indexOf("V3FundsDeposited");
    const latestDepositId = (events[idx] ?? []).reduce(
      (depositId, event) => bnMax(depositId, event.args["depositId"] ?? bnZero),
      this.latestDepositIdQueried
    );

    return Promise.resolve({
      success: true,
      firstDepositId: bnZero,
      latestDepositId,
      currentTime,
      oldestTime: 0,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockSearched,
    });
  }

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    EnabledDepositRoute: "address,uint256,bool",
  };

  deposit(deposit: Omit<Deposit, "messageHash"> & Partial<SortableEvent>): Log {
    return this._deposit("FundsDeposited", deposit);
  }

  depositV3(deposit: Omit<Deposit, "messageHash"> & Partial<SortableEvent>): Log {
    return this._deposit("V3FundsDeposited", deposit);
  }

  protected _deposit(event: string, deposit: Omit<Deposit, "messageHash"> & Partial<SortableEvent>): Log {
    const { blockNumber, transactionIndex } = deposit;
    let { depositId, destinationChainId, inputAmount, outputAmount } = deposit;
    depositId ??= this.numberOfDeposits;
    this.numberOfDeposits = depositId.add(bnOne);

    destinationChainId ??= random(1, 42161, false);
    const addressModifier = event === "FundsDeposited" ? toBytes32 : toAddress;
    const depositor = addressModifier(deposit.depositor ?? randomAddress());
    const recipient = addressModifier(deposit.recipient ?? depositor);
    const inputToken = addressModifier(deposit.inputToken ?? randomAddress());
    const outputToken = addressModifier(deposit.outputToken ?? inputToken);
    const exclusiveRelayer = addressModifier(deposit.exclusiveRelayer ?? ZERO_ADDRESS);

    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount.mul(toBN("0.95"));

    const message = deposit["message"] ?? "0x";
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
      transactionIndex,
    });
  }

  fillV3Relay(fill: Omit<Fill, "messageHash"> & { message: string } & Partial<SortableEvent>): Log {
    return this._fillRelay("FilledV3Relay", fill);
  }

  fillRelay(fill: Omit<Fill, "messageHash"> & { message: string } & Partial<SortableEvent>): Log {
    return this._fillRelay("FilledRelay", fill);
  }

  protected _fillRelay(
    event: string,
    fill: Omit<Fill, "messageHash"> & { message: string } & Partial<SortableEvent>
  ): Log {
    const { blockNumber, transactionIndex } = fill;
    let { originChainId, depositId, inputAmount, outputAmount, fillDeadline } = fill;
    originChainId ??= random(1, 42161, false);
    depositId ??= BigNumber.from(random(1, 100_000, false));
    inputAmount ??= toBNWei(random(1, 1000, false));
    outputAmount ??= inputAmount;
    fillDeadline ??= getCurrentTime() + 60;

    const addressModifier = event === "FilledRelay" ? toBytes32 : toAddress;
    const depositor = addressModifier(fill.depositor ?? randomAddress());
    const recipient = addressModifier(fill.recipient ?? depositor);
    const inputToken = addressModifier(fill.inputToken ?? randomAddress());
    const outputToken = addressModifier(fill.outputToken ?? ZERO_ADDRESS);
    const exclusiveRelayer = addressModifier(fill.exclusiveRelayer ?? ZERO_ADDRESS);
    const relayer = addressModifier(fill.relayer ?? randomAddress());

    const topics = [originChainId, depositId, relayer]; // @todo verify
    const message = fill.message ?? EMPTY_MESSAGE;
    const updatedMessage = fill.relayExecutionInfo?.updatedMessage ?? message;

    const relayExecutionInfo = {
      updatedRecipient: fill.relayExecutionInfo?.updatedRecipient ?? recipient,
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
        updatedRecipient: fill.relayExecutionInfo?.updatedRecipient ?? recipient,
        updatedOutputAmount: fill.relayExecutionInfo?.updatedOutputAmount ?? outputAmount,
        fillType: fill.relayExecutionInfo?.fillType ?? FillType.FastFill,
      },
    };

    const args =
      event === "FilledRelay"
        ? {
            ..._args,
            messageHash: getMessageHash(message),
            relayExecutionInfo: {
              ...relayExecutionInfo,
              updatedMessageHash: getMessageHash(updatedMessage),
            },
          }
        : {
            // FilledV3Relay
            ..._args,
            message,
            relayExecutionInfo: {
              ...relayExecutionInfo,
              updatedMessage,
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

  speedUpV3Deposit(speedUp: SpeedUp): Log {
    return this._speedUpDeposit("RequestedSpeedUpV3Deposit", speedUp);
  }

  speedUpDeposit(speedUp: SpeedUp): Log {
    return this._speedUpDeposit("RequestedSpeedUpDeposit", speedUp);
  }

  protected _speedUpDeposit(event: string, speedUp: SpeedUp): Log {
    const addressModifier = event === "RequestedSpeedUpDeposit" ? toBytes32 : toAddress;
    const depositor = addressModifier(speedUp.depositor);
    const topics = [speedUp.depositId, depositor];
    const args = { ...speedUp };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args: {
        ...args,
        depositor,
        updatedRecipient: addressModifier(speedUp.updatedRecipient),
      },
    });
  }

  setTokensBridged(tokensBridged: TokensBridged): Log {
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

  requestV3SlowFill(request: Omit<SlowFillRequest, "messageHash"> & Partial<SortableEvent>): Log {
    return this._requestSlowFill("RequestedV3SlowFill", request);
  }

  requestSlowFill(request: Omit<SlowFillRequest, "messageHash"> & Partial<SortableEvent>): Log {
    return this._requestSlowFill("RequestedSlowFill", request);
  }

  protected _requestSlowFill(
    event: string,
    request: Omit<SlowFillRequest, "messageHash"> & Partial<SortableEvent>
  ): Log {
    const { originChainId, depositId } = request;
    const topics = [originChainId, depositId];
    const args = { ...request };

    const addressModifier = event === "RequestedSlowFill" ? toBytes32 : toAddress;
    const depositor = addressModifier(args.depositor ?? randomAddress());

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args: {
        ...args,
        depositor,
        recipient: addressModifier(args.recipient ?? depositor),
        inputToken: addressModifier(args.inputToken ?? randomAddress()),
        outputToken: addressModifier(args.outputToken ?? ZERO_ADDRESS),
        exclusiveRelayer: addressModifier(args.exclusiveRelayer ?? ZERO_ADDRESS),
      },
      blockNumber: request.blockNumber,
      transactionIndex: request.transactionIndex,
    });
  }

  // This is a simple wrapper around fillV3Relay().
  // rootBundleId and proof are discarded here - we have no interest in verifying that.
  executeV3SlowRelayLeaf(leaf: Omit<SlowFillLeaf, "messageHash">): Log {
    const fill = {
      ...leaf.relayData,
      destinationChainId: this.chainId,
      relayer: ZERO_ADDRESS,
      repaymentChainId: 0,
      relayExecutionInfo: {
        updatedRecipient: leaf.relayData.recipient,
        updatedOutputAmount: leaf.updatedOutputAmount,
        updatedMessage: leaf.relayData.message,
        updatedMessageHash: getMessageHash(leaf.relayData.message),
        fillType: FillType.SlowFill,
      },
    };

    return this.fillV3Relay(fill);
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
