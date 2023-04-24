import { ChainId } from "./adapters/web3/model";

export type SpokePoolConfig = {
  lowerBoundBlockNumber?: number;
};

export type ClientConfig = {
  spokePools: Record<ChainId, SpokePoolConfig>;
};

export const clientConfig: ClientConfig = {
  spokePools: {},
};
