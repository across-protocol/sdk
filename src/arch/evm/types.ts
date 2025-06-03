import { L2Provider } from "@eth-optimism/sdk";
import { providers } from "ethers";

export type Provider = providers.Provider;
export type OptimismProvider = L2Provider<Provider>;

export type EvmProvider = providers.Provider | OptimismProvider;
