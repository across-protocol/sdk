export { CHAIN_IDs } from "../../../constants";

export type Web3Error = {
  error: {
    code: Web3ErrorCode;
  };
};

export enum Web3ErrorCode {
  BLOCK_RANGE_TOO_LARGE = -32005,
  EXCEEDED_MAXIMUM_BLOCK_RANGE = -32000,
}

export type ChainId = number;
