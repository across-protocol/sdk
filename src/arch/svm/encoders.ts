import {
  AccountRole,
  addDecoderSizePrefix,
  addEncoderSizePrefix,
  getAddressDecoder,
  getAddressEncoder,
  getArrayEncoder,
  getArrayDecoder,
  getBytesDecoder,
  getBytesEncoder,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU8Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  type Address,
  type Decoder,
  type Encoder,
  type ReadonlyUint8Array,
  type WritableAccount,
  type ReadonlyAccount,
} from "@solana/kit";

export type AcrossPlusMessage = {
  handler: Address;
  read_only_len: number;
  value_amount: bigint;
  accounts: Array<Address>;
  handler_message: ReadonlyUint8Array;
};

export function getAcrossPlusMessageEncoder(): Encoder<AcrossPlusMessage> {
  return getStructEncoder([
    ["handler", getAddressEncoder()],
    ["read_only_len", getU8Encoder()],
    ["value_amount", getU64Encoder()],
    ["accounts", getArrayEncoder(getAddressEncoder())],
    ["handler_message", addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())],
  ]);
}

export function getAcrossPlusMessageDecoder(): Decoder<AcrossPlusMessage> {
  return getStructDecoder([
    ["handler", getAddressDecoder()],
    ["read_only_len", getU8Decoder()],
    ["value_amount", getU64Decoder()],
    ["accounts", getArrayDecoder(getAddressDecoder())],
    ["handler_message", addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())],
  ]);
}

export function getAccountMeta(value: Address, isWritable: boolean): WritableAccount | ReadonlyAccount {
  return Object.freeze({
    address: value,
    role: isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
  });
}
