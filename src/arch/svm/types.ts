import { Rpc, SolanaRpcApi } from "@solana/kit";
import { Blockhash, UnixTimestamp } from "@solana/rpc-types";

// @todo: Import this definition from kit.
export type Block = {
  blockHeight: bigint;
  blockTime: UnixTimestamp;
  blockHash: Blockhash;
  parentSlot: string;
};

export type Provider = Rpc<SolanaRpcApi>;
