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
import { CHAIN_IDs, UNDEFINED_MESSAGE_HASH } from "../../../constants";
import { BigNumber, EvmAddress, RawAddress, SvmAddress, toAddressType } from "../../../utils";

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

// Accept any concrete implementation of `Address` (Evm, Svm, or Raw) but avoid using the
// abstract `Address` class directly to keep TypeScript happy.
const AddressInstanceSS = union([instance(EvmAddress), instance(SvmAddress), instance(RawAddress)]);

const AddressType = coerce(AddressInstanceSS, string(), (value) => {
  // Addresses are posted to arweave in their native format (base16 for EVM, base58 for SVM). The chainId for
  // for the event data is not directly available, so infer it based on the shape of the address. RawAddress
  // will be instantiated if the address format does not match the expected family.
  const chainId = value.startsWith("0x") ? CHAIN_IDs.MAINNET : CHAIN_IDs.SOLANA;
  return toAddressType(value, chainId);
});

const FillTypeSS = number();

const V3RelayDataSS = {
  inputToken: AddressType,
  inputAmount: BigNumberType,
  outputToken: AddressType,
  outputAmount: BigNumberType,
  fillDeadline: number(),
  exclusiveRelayer: AddressType,
  exclusivityDeadline: number(),
  originChainId: number(),
  depositor: AddressType,
  recipient: AddressType,
  depositId: BigNumberType,
  message: string(),
};

export const SortableEventSS = {
  blockNumber: number(),
  logIndex: number(),

  txnRef: optional(string()),
  txnIndex: optional(number()),

  transactionHash: optional(string()),
  transactionIndex: optional(number()),
};

const V3DepositSS = {
  messageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
  fromLiteChain: defaulted(boolean(), false),
  toLiteChain: defaulted(boolean(), false),
  destinationChainId: number(),
  quoteTimestamp: number(),
  relayerFeePct: optional(BigNumberType),
  speedUpSignature: optional(string()),
  updatedRecipient: optional(AddressType),
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
  updatedRecipient: AddressType,
  updatedMessage: optional(string()),
  updatedMessageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
});

const V3FillSS = {
  ...V3RelayDataSS,
  message: optional(string()),
  messageHash: defaulted(string(), UNDEFINED_MESSAGE_HASH),
  destinationChainId: number(),
  relayer: AddressType,
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
