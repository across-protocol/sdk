import { CHAIN_IDs, PRODUCTION_CHAIN_IDS, PUBLIC_NETWORKS, TESTNET_CHAIN_IDS } from "../constants";

const hreNetworks: Record<number, string> = {
  666: "Hardhat1",
  1337: "Hardhat2",
};

/**
 * Resolves a network name from a network id.
 * @param networkId The network id to resolve the name for
 * @returns The network name for the network id. If the network id is not found, returns "unknown"
 */
export function getNetworkName(networkId: number | string): string {
  networkId = Number(networkId);
  return PUBLIC_NETWORKS[networkId]?.name ?? hreNetworks[networkId] ?? "unknown";
}

/**
 * Resolves a native token symbol from a chain id.
 * @param chainId The chain id to resolve the native token symbol for
 * @returns The native token symbol for the chain id. If the chain id is not found, returns "ETH"
 */
export function getNativeTokenSymbol(chainId: number | string): string {
  return PUBLIC_NETWORKS[Number(chainId)]?.nativeToken ?? "ETH";
}

/**
 * Determines whether a chain ID is part of the production network.
 * @param chainId Chain ID to query.
 * @returns true if the chain ID is part of the production network, otherwise false.
 */
export function chainIsProd(chainId: number): boolean {
  return PRODUCTION_CHAIN_IDS.includes(chainId);
}

/**
 * Determines whether a chain ID is part of the production network.
 * @param chainId Chain ID to query.
 * @returns true if the chain ID is part of the production network, otherwise false.
 */
export function chainIsTestnet(chainId: number): boolean {
  return TESTNET_CHAIN_IDS.includes(chainId);
}

/**
 * Determines whether a chain ID is an Optimism OP Stack implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is an OP stack, otherwise false.
 */
export function chainIsOPStack(chainId: number): boolean {
  return [
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.BASE,
    CHAIN_IDs.OPTIMISM_GOERLI,
    CHAIN_IDs.BASE_GOERLI,
    CHAIN_IDs.OPTIMISM_SEPOLIA,
    CHAIN_IDs.BASE_SEPOLIA,
  ].includes(chainId);
}

/**
 * Determines whether a chain ID is an Arbitrum implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is an Arbitrum chain, otherwise false.
 */
export function chainIsArbitrum(chainId: number): boolean {
  return [CHAIN_IDs.ARBITRUM, CHAIN_IDs.ARBITRUM_GOERLI, CHAIN_IDs.ARBITRUM_SEPOLIA].includes(chainId);
}

/**
 * Determines whether a chain ID is a Linea implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a Linea chain, otherwise false.
 */
export function chainIsLinea(chainId: number): boolean {
  return [CHAIN_IDs.LINEA, CHAIN_IDs.LINEA_GOERLI].includes(chainId);
}
