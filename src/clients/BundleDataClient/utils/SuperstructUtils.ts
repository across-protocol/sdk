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
import { utils as ethersUtils } from "ethers";
import { isAddress as isValidEvmAddress } from "viem";
import { isAddress as isValidSvmAddress } from "@solana/kit";
import { TronWeb } from "tronweb";
import { UNDEFINED_MESSAGE_HASH } from "../../../constants";
import { BigNumber, bs58, EvmAddress, RawAddress, SvmAddress, TvmAddress, toBytes32 } from "../../../utils";

const PositiveIntegerStringSS = pattern(string(), /\d+/);
const Web3AddressSS = pattern(string(), /^0x[a-fA-F0-9]{64}$/);

const BigNumberType = coerce(instance(BigNumber), union([string(), number()]), (value) => {
  try {
    // Attempt to convert the string to a BigNumber
    return BigNumber.from(value);
  } catch {
    // In case of any error during conversion, return the original value
    // This will lead to a validation error, as the resulting value won't match the expected BigNumber type
    return value;
  }
});

const AddressInstanceSS = union([
  instance(EvmAddress),
  instance(SvmAddress),
  instance(TvmAddress),
  instance(RawAddress),
]);

export const AddressType = coerce(AddressInstanceSS, string(), (value) => {
  // Each family is matched by its native-format validator plus a length gate where it
  // disambiguates. Unknown shapes fall to `RawAddress`, forcing future families into explicit
  // branches rather than being absorbed silently.
  try {
    if (value.length === 42 && isValidEvmAddress(value)) return EvmAddress.from(value);
    if (value.length === 34 && TronWeb.isAddress(value)) return TvmAddress.from(value);
    if (isValidSvmAddress(value)) return SvmAddress.from(value);
  } catch {
    // Validator accepted but `from()` rejected (e.g. SVM 12-zero EVM-masquerade) → RawAddress.
  }
  return new RawAddress(value.startsWith("0x") ? ethersUtils.arrayify(value) : bs58.decode(value));
});

const Web3AddressType = coerce(Web3AddressSS, string(), (value) => {
  return toBytes32(value);
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

const nestedV3DepositRecordSS = record(PositiveIntegerStringSS, record(Web3AddressType, array(V3DepositWithBlockSS)));
const nestedV3DepositRecordWithLpFeePctSS = record(
  PositiveIntegerStringSS,
  record(Web3AddressType, array(V3DepositWithBlockLpFeeSS))
);

const nestedV3BundleFillsSS = record(
  // Must be a chainId
  PositiveIntegerStringSS,
  record(
    Web3AddressType,
    object({
      fills: array(BundleFillV3SS),
      refunds: record(Web3AddressType, BigNumberType),
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
