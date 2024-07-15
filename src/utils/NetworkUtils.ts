import { CHAIN_IDs, MAINNET_CHAIN_IDs, PUBLIC_NETWORKS, TESTNET_CHAIN_IDs } from "../constants";

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
  return Object.values(MAINNET_CHAIN_IDs).includes(chainId);
}

/**
 * Determines whether a chain ID is part of the production network.
 * @param chainId Chain ID to query.
 * @returns true if the chain ID is part of the production network, otherwise false.
 */
export function chainIsTestnet(chainId: number): boolean {
  return Object.values(TESTNET_CHAIN_IDs).includes(chainId);
}

/**
 * Determines whether a chain ID is a Polygon implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a Polygon chain (mainnet or testnet), otherwise false.
 */
export function chainIsMatic(chainId: number): boolean {
  return [CHAIN_IDs.POLYGON, CHAIN_IDs.POLYGON_AMOY].includes(chainId);
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
    CHAIN_IDs.BLAST,
    CHAIN_IDs.LISK,
    CHAIN_IDs.MODE,
    CHAIN_IDs.OPTIMISM_SEPOLIA,
    CHAIN_IDs.BASE_SEPOLIA,
    CHAIN_IDs.BLAST_SEPOLIA,
    CHAIN_IDs.LISK_SEPOLIA,
    CHAIN_IDs.MODE_SEPOLIA,
  ].includes(chainId);
}

/**
 * Determines whether a chain ID is an Arbitrum implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is an Arbitrum chain, otherwise false.
 */
export function chainIsArbitrum(chainId: number): boolean {
  return [CHAIN_IDs.ARBITRUM, CHAIN_IDs.ARBITRUM_SEPOLIA].includes(chainId);
}

/**
 * Determines whether a chain ID is a Linea implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a Linea chain, otherwise false.
 */
export function chainIsLinea(chainId: number): boolean {
  return [CHAIN_IDs.LINEA].includes(chainId);
}

/**
 * Determines whether a chain ID has a corresponding hub pool contract.
 * @param chainId Chain ID to evaluate.
 * @returns True if chain corresponding to chainId has a hub pool implementation.
 */
export function chainIsL1(chainId: number): boolean {
  return [CHAIN_IDs.MAINNET, CHAIN_IDs.SEPOLIA].includes(chainId);
}

/**
 * Determines whether a chain ID has the capacity for having its USDC bridged via CCTP.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a CCTP-bridging enabled chain, otherwise false.
 */
export function chainIsCCTPEnabled(chainId: number): boolean {
  return [
    // Mainnets
    CHAIN_IDs.BASE,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.POLYGON,
    // Testnets
    CHAIN_IDs.BASE_SEPOLIA,
    CHAIN_IDs.OPTIMISM_SEPOLIA,
    CHAIN_IDs.ARBITRUM_SEPOLIA,
    CHAIN_IDs.POLYGON_AMOY,
  ].includes(chainId);
}

/**
 * Determines if a chain ID requires a manual L1 -> L2 finalization step.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId requires manual L1 -> L2 finalization, otherwise false.
 */
export function chainRequiresL1ToL2Finalization(chainId: number): boolean {
  return chainIsCCTPEnabled(chainId) || chainIsLinea(chainId);
}
