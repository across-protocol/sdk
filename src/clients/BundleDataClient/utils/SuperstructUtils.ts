import {
  Infer,
  object,
  number,
  optional,
  string,
  array,
  record,
  coerce,
  instance,
  pattern,
  boolean,
  defaulted,
  union,
  type,
} from "superstruct";
import { UNDEFINED_MESSAGE_HASH } from "../../../constants";
import { BigNumber } from "../../../utils";

const PositiveIntegerStringSS = pattern(string(), /\d+/);
const Web3AddressSS = pattern(string(), /^0x[a-fA-F0-9]{40}$/);

const BigNumberType = coerce(instance(BigNumber), union([string(), number()]), (value) => {
  try {
    // Attempt to convert the string to a BigNumber
    return BigNumber.from(value);
  } catch (error) {
    // In case of any error during conversion, return the original value
    // This will lead to a validation error, as the resulting value won't match the expected BigNumber type
    return value;
  }
});

const FillTypeSS = number();

const PartialV3RelayDataSS = {
  inputToken: string(),
  inputAmount: BigNumberType,
  outputToken: string(),
  outputAmount: BigNumberType,
  fillDeadline: number(),
  exclusiveRelayer: string(),
  exclusivityDeadline: number(),
  originChainId: number(),
  depositor: string(),
  recipient: string(),
  depositId: BigNumberType,
  message: optional(string()),
};

const V3RelayDataSS = {
  inputToken: string(),
  inputAmount: BigNumberType,
  outputToken: string(),
  outputAmount: BigNumberType,
  fillDeadline: number(),
  exclusiveRelayer: string(),
  exclusivityDeadline: number(),
  originChainId: number(),
  depositor: string(),
  recipient: string(),
  depositId: BigNumberType,
  message: string(),
};

const SortableEventSS = {
  blockNumber: number(),
  transactionIndex: number(),
  logIndex: number(),
  transactionHash: string(),
};

const V3DepositSS = {
  messageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
  fromLiteChain: defaulted(boolean(), false),
  toLiteChain: defaulted(boolean(), false),
  destinationChainId: number(),
  quoteTimestamp: number(),
  relayerFeePct: optional(BigNumberType),
  speedUpSignature: optional(string()),
  updatedRecipient: optional(string()),
  updatedOutputAmount: optional(BigNumberType),
  updatedMessage: optional(string()),
};

const _V3DepositWithBlockSS = {
  quoteBlockNumber: number(),
  ...V3DepositSS,
  ...SortableEventSS,
  ...V3RelayDataSS,
};

const V3DepositWithBlockSS = object(_V3DepositWithBlockSS);
const V3DepositWithBlockLpFeeSS = object({
  ..._V3DepositWithBlockSS,
  lpFeePct: BigNumberType,
});

const V3RelayExecutionEventInfoSS = object({
  updatedOutputAmount: BigNumberType,
  fillType: FillTypeSS,
  updatedRecipient: string(),
  updatedMessage: optional(string()),
  updatedMessageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
});

const V3FillSS = {
  ...PartialV3RelayDataSS,
  messageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
  destinationChainId: number(),
  relayer: string(),
  repaymentChainId: number(),
  relayExecutionInfo: V3RelayExecutionEventInfoSS,
  quoteTimestamp: number(),
};

const V3FillWithBlockSS = {
  ...SortableEventSS,
  ...V3FillSS,
};

const BundleFillV3SS = object({
  ...V3FillWithBlockSS,
  lpFeePct: BigNumberType,
});

const nestedV3DepositRecordSS = record(PositiveIntegerStringSS, record(Web3AddressSS, array(V3DepositWithBlockSS)));
const nestedV3DepositRecordWithLpFeePctSS = record(
  PositiveIntegerStringSS,
  record(Web3AddressSS, array(V3DepositWithBlockLpFeeSS))
);

const nestedV3BundleFillsSS = record(
  // Must be a chainId
  PositiveIntegerStringSS,
  record(
    Web3AddressSS,
    object({
      fills: array(BundleFillV3SS),
      refunds: record(string(), BigNumberType),
      totalRefundAmount: BigNumberType,
      realizedLpFees: BigNumberType,
    })
  )
);

export const BundleDataSS = type({
  bundleDepositsV3: nestedV3DepositRecordSS,
  expiredDepositsToRefundV3: nestedV3DepositRecordSS,
  unexecutableSlowFills: nestedV3DepositRecordWithLpFeePctSS,
  bundleSlowFillsV3: nestedV3DepositRecordWithLpFeePctSS,
  bundleFillsV3: nestedV3BundleFillsSS,
});

export type BundleData = Infer<typeof BundleDataSS>;
