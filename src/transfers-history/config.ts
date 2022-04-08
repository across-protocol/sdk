import { ChainId } from "./adapters/web3/model";

export type SpokePoolConfig = {
  lowerBoundBlockNumber?: number;
};

export type ClientConfig = {
  web3ProvidersUrls: Record<ChainId, string>;
  spokePools: Record<ChainId, SpokePoolConfig>;
};

export const clientConfig: ClientConfig = {
  web3ProvidersUrls: {},
  spokePools: {},
};
