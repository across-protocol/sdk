export type Web3Error = {
  reason: string;
  code: string;
  body: any;
  error: {
    code: Web3ErrorCode;
  };
  requestBody: string;
  requestMethod: string;
  url: string;
};

export enum Web3ErrorCode {
  BLOCK_RANGE_TOO_LARGE = -32005,
}
