import {
  BridgedToHubPoolWithBlock,
  BridgedToHubPoolWithBlockRaw,
  BridgedToHubPoolWithBlockRawStruct,
  ClaimedRelayerRefundWithBlock,
  ClaimedRelayerRefundWithBlockRaw,
  ClaimedRelayerRefundWithBlockRawStruct,
  Deposit,
  DepositWithBlockRaw,
  DepositWithBlockRawStruct,
  EnabledDepositRoute,
  EnabledDepositRouteWithBlockRaw,
  EnabledDepositRouteWithBlockRawStruct,
  Fill,
  FillWithBlockRaw,
  FillWithBlockRawStruct,
  RelayerRefundExecution,
  RelayerRefundExecutionWithBlockRaw,
  RelayerRefundExecutionWithBlockRawStruct,
  RootBundleRelay,
  RootBundleRelayWithBlockRaw,
  RootBundleRelayWithBlockRawStruct,
  SlowFillRequest,
  SlowFillRequestWithBlockRaw,
  SlowFillRequestWithBlockRawStruct,
  SpeedUp,
  SpeedUpWithBlockRaw,
  SpeedUpWithBlockRawStruct,
  TokensBridged,
  TokensBridgedRaw,
  TokensBridgedRawStruct,
} from ".";
import { CHAIN_IDs } from "../constants";
import { EventArgsDecoder } from "../utils/EventParsing";
import { BigNumber, EvmAddress, toAddressType } from "../utils";

type SpokePoolClientContext = {
  chainId: number;
};

// Note: The decoders now produce intermediate types (e.g., `Deposit`) that only contain
// fields derivable from the event args. The `...WithBlock` types, which include
// `SortableEvent` props, will be constructed by the high-level `decodeSortableEvent` wrapper.
export const DepositArgsDecoder: EventArgsDecoder<
  DepositWithBlockRaw,
  Omit<Deposit, "messageHash" | "fromLiteChain" | "toLiteChain">,
  SpokePoolClientContext
> = {
  struct: DepositWithBlockRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");
    return {
      ...raw,
      depositor: toAddressType(raw.depositor, context.chainId),
      recipient: toAddressType(raw.recipient, raw.destinationChainId),
      inputToken: toAddressType(raw.inputToken, context.chainId),
      outputToken: toAddressType(raw.outputToken, raw.destinationChainId),
      exclusiveRelayer: toAddressType(raw.exclusiveRelayer, raw.destinationChainId),
      depositId: BigNumber.from(raw.depositId),
      inputAmount: BigNumber.from(raw.inputAmount),
      outputAmount: BigNumber.from(raw.outputAmount),
    };
  },
};

export const SpeedUpArgsDecoder: EventArgsDecoder<SpeedUpWithBlockRaw, SpeedUp, SpokePoolClientContext> = {
  struct: SpeedUpWithBlockRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");
    return {
      ...raw,
      depositor: EvmAddress.from(raw.depositor),
      updatedRecipient: EvmAddress.from(raw.updatedRecipient),
      depositId: BigNumber.from(raw.depositId),
      updatedOutputAmount: BigNumber.from(raw.updatedOutputAmount),
      originChainId: context.chainId,
    };
  },
};

export const SlowFillRequestArgsDecoder: EventArgsDecoder<
  SlowFillRequestWithBlockRaw,
  SlowFillRequest,
  SpokePoolClientContext
> = {
  struct: SlowFillRequestWithBlockRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");
    return {
      ...raw,
      depositor: toAddressType(raw.depositor, raw.originChainId),
      recipient: toAddressType(raw.recipient, context.chainId),
      inputToken: toAddressType(raw.inputToken, raw.originChainId),
      outputToken: toAddressType(raw.outputToken, context.chainId),
      exclusiveRelayer: toAddressType(raw.exclusiveRelayer, context.chainId),
      depositId: BigNumber.from(raw.depositId),
      inputAmount: BigNumber.from(raw.inputAmount),
      outputAmount: BigNumber.from(raw.outputAmount),
      destinationChainId: context.chainId,
      messageHash: raw.messageHash,
    };
  },
};

export const FillArgsDecoder: EventArgsDecoder<FillWithBlockRaw, Fill, SpokePoolClientContext> = {
  struct: FillWithBlockRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");
    return {
      ...raw,
      depositor: toAddressType(raw.depositor, raw.originChainId),
      recipient: toAddressType(raw.recipient, context.chainId),
      inputToken: toAddressType(raw.inputToken, raw.originChainId),
      outputToken: toAddressType(raw.outputToken, context.chainId),
      exclusiveRelayer: toAddressType(raw.exclusiveRelayer, context.chainId),
      relayer: toAddressType(raw.relayer, context.chainId),
      depositId: BigNumber.from(raw.depositId),
      inputAmount: BigNumber.from(raw.inputAmount),
      outputAmount: BigNumber.from(raw.outputAmount),
      fillDeadline: raw.fillDeadline,
      relayExecutionInfo: {
        ...raw.relayExecutionInfo,
        updatedRecipient: toAddressType(raw.relayExecutionInfo.updatedRecipient, context.chainId),
        updatedOutputAmount: BigNumber.from(raw.relayExecutionInfo.updatedOutputAmount),
      },
      destinationChainId: context.chainId,
      messageHash: raw.messageHash,
    };
  },
};

export const EnabledDepositRouteArgsDecoder: EventArgsDecoder<EnabledDepositRouteWithBlockRaw, EnabledDepositRoute> = {
  struct: EnabledDepositRouteWithBlockRawStruct,
  parse: (raw) => ({
    ...raw,
    originToken: toAddressType(raw.originToken, CHAIN_IDs.MAINNET),
  }),
};

export const RootBundleRelayArgsDecoder: EventArgsDecoder<RootBundleRelayWithBlockRaw, RootBundleRelay> = {
  struct: RootBundleRelayWithBlockRawStruct,
  parse: (raw) => raw,
};

export const RelayerRefundExecutionArgsDecoder: EventArgsDecoder<
  RelayerRefundExecutionWithBlockRaw,
  RelayerRefundExecution,
  SpokePoolClientContext
> = {
  struct: RelayerRefundExecutionWithBlockRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");

    return {
      ...raw,
      l2TokenAddress: toAddressType(raw.l2TokenAddress, context.chainId),
      amountToReturn: BigNumber.from(raw.amountToReturn),
      refundAddresses: raw.refundAddresses.map((addr) => toAddressType(addr, context.chainId)),
      refundAmounts: raw.refundAmounts.map((amount) => BigNumber.from(amount)),
    };
  },
};

export const TokensBridgedArgsDecoder: EventArgsDecoder<
  TokensBridgedRaw,
  Omit<TokensBridged, "txnIndex" | "txnRef" | "logIndex" | "blockNumber">,
  SpokePoolClientContext
> = {
  struct: TokensBridgedRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");
    return {
      ...raw,
      l2TokenAddress: toAddressType(raw.l2TokenAddress, context.chainId),
      amountToReturn: BigNumber.from(raw.amountToReturn),
    };
  },
};

export const ClaimedRelayerRefundArgsDecoder: EventArgsDecoder<
  ClaimedRelayerRefundWithBlockRaw,
  Omit<ClaimedRelayerRefundWithBlock, "txnIndex" | "txnRef" | "logIndex" | "blockNumber">
> = {
  struct: ClaimedRelayerRefundWithBlockRawStruct,
  parse: (raw) => ({
    ...raw,
    l2TokenAddress: raw.l2TokenAddress,
    refundAddress: raw.refundAddress,
    amount: BigNumber.from(raw.amount ?? raw.claimAmount ?? 0),
  }),
};

export const BridgedToHubPoolArgsDecoder: EventArgsDecoder<
  BridgedToHubPoolWithBlockRaw,
  Omit<BridgedToHubPoolWithBlock, "txnIndex" | "txnRef" | "logIndex" | "blockNumber">
> = {
  struct: BridgedToHubPoolWithBlockRawStruct,
  parse: (raw) => ({
    ...raw,
    amount: BigNumber.from(raw.amount),
    mint: raw.mint,
  }),
};
