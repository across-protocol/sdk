import { ChainId, CHAIN_IDs } from "./adapters/web3/model";

export type SpokePoolConfig = {
  lowerBoundBlockNumber: number;
};

export type ClientConfig = {
  web3ProvidersUrls: Record<ChainId, string>;
  spokePools: Record<ChainId, SpokePoolConfig>;
};

export const clientConfig: ClientConfig = {
  web3ProvidersUrls: {},
  spokePools: {
    [CHAIN_IDs.ARBITRUM_RINKEBY]: { lowerBoundBlockNumber: 9828565 },
    [CHAIN_IDs.OPTIMISM_KOVAN]: { lowerBoundBlockNumber: 0 },
    [CHAIN_IDs.RINKEBY]: { lowerBoundBlockNumber: 0 },
    [CHAIN_IDs.KOVAN]: { lowerBoundBlockNumber: 0 },
    [CHAIN_IDs.MAINNET]: { lowerBoundBlockNumber: 0 },
  },
};
