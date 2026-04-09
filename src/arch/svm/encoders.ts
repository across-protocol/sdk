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

export type CompiledIx = {
  program_id_index: number;
  account_key_indexes: Array<number>;
  data: ReadonlyUint8Array;
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

export function getHandlerMessageEncoder(): Encoder<Array<CompiledIx>> {
  return getArrayEncoder(getCompiledIxEncoder());
}

export function getHandlerMessageDecoder(): Decoder<Array<CompiledIx>> {
  return getArrayDecoder(getCompiledIxDecoder());
}

export function getCompiledIxEncoder(): Encoder<CompiledIx> {
  return getStructEncoder([
    ["program_id_index", getU8Encoder()],
    ["account_key_indexes", getArrayEncoder(getU8Encoder())],
    ["data", addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())],
  ]);
}

export function getCompiledIxDecoder(): Decoder<CompiledIx> {
  return getStructDecoder([
    ["program_id_index", getU8Decoder()],
    ["account_key_indexes", getArrayDecoder(getU8Decoder())],
    ["data", addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())],
  ]);
}

export function getAccountMeta(value: Address, isWritable: boolean): WritableAccount | ReadonlyAccount {
  return Object.freeze({
    address: value,
    role: isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
  });
}
