import { ChainId, CHAIN_IDs } from "./adapters/web3/model";

export type SpokePoolConfig = {
  addr: string;
  lowerBoundBlockNumber: number;
};

export type ClientConfig = {
  web3ProvidersUrls: Record<ChainId, string>;
  spokePools: Record<ChainId, SpokePoolConfig>;
};

export const clientConfig: ClientConfig = {
  web3ProvidersUrls: {},
  spokePools: {
    [CHAIN_IDs.ARBITRUM_RINKEBY]: {
      addr: "0x68306388c266dce735245A0A6DAe6Dd3b727A640",
      lowerBoundBlockNumber: 9828565,
    },
    [CHAIN_IDs.OPTIMISM_KOVAN]: { addr: "0x99EC530a761E68a377593888D9504002Bd191717", lowerBoundBlockNumber: 0 },
    [CHAIN_IDs.RINKEBY]: { addr: "0x90743806D7A66b37F31FAfd7b3447210aB55640f", lowerBoundBlockNumber: 0 },
    [CHAIN_IDs.KOVAN]: { addr: "0x73549B5639B04090033c1E77a22eE9Aa44C2eBa0", lowerBoundBlockNumber: 0 },
  },
};
