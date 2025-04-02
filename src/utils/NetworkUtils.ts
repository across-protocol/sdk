import {
  CCTP_NO_DOMAIN,
  ChainFamily,
  CHAIN_IDs,
  MAINNET_CHAIN_IDs,
  PRODUCTION_NETWORKS,
  PUBLIC_NETWORKS,
  TESTNET_CHAIN_IDs,
} from "../constants";

export const hreNetworks: Record<number, string> = {
  666: "Hardhat1",
  1337: "Hardhat2",
  31337: "HardhatNetwork",
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
  return PUBLIC_NETWORKS[chainId]?.family === ChainFamily.OP_STACK;
}

/**
 * Determines whether a chain ID is a ZkStack implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a ZkStack chain, otherwise false.
 */
export function chainIsZkStack(chainId: number): boolean {
  return PUBLIC_NETWORKS[chainId]?.family === ChainFamily.ZK_STACK;
}

/**
 * Determines whether a chain ID is an Arbitrum Orbit implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is an Orbit chain, otherwise false.
 */
export function chainIsOrbit(chainId: number): boolean {
  return PUBLIC_NETWORKS[chainId]?.family === ChainFamily.ORBIT;
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
 * Determines whether a chain ID runs on an EVM-like execution layer.
 * @param chainId Chain ID to evaluate.
 * @returns True if chain corresponding to chainId has an EVM-like execution layer.
 */
export function chainIsEvm(chainId: number): boolean {
  // TODO: Update when additional execution layers beyond EVM and SVM are supported.
  return PUBLIC_NETWORKS[chainId]?.family !== ChainFamily.SVM;
}

/**
 * Determines whether a chain ID runs on an SVM-like execution layer.
 * @param chainId Chain ID to evaluate.
 * @returns True if chain corresponding to chainId has an SVM-like execution layer.
 */
export function chainIsSvm(chainId: number): boolean {
  return PUBLIC_NETWORKS[chainId]?.family === ChainFamily.SVM;
}

/**
 * Determines whether a chain ID has the capacity for having its USDC bridged via CCTP.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is a CCTP-bridging enabled chain, otherwise false.
 */
export function chainIsCCTPEnabled(chainId: number): boolean {
  // Add chainIds to cctpExceptions to administratively disable CCTP on a chain.
  // This is useful if constants has been updated to specify a CCTP domain in advance of it being activated.
  const cctpExceptions: number[] = [];
  return PRODUCTION_NETWORKS[chainId]?.cctpDomain !== CCTP_NO_DOMAIN && !cctpExceptions.includes(chainId);
}

/**
 * Determines if a chain ID requires a manual L1 -> L2 finalization step.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId requires manual L1 -> L2 finalization, otherwise false.
 */
export function chainRequiresL1ToL2Finalization(chainId: number): boolean {
  return chainIsCCTPEnabled(chainId) || chainIsLinea(chainId);
}

/**
 * Returns the origin of a URL.
 * @param url A URL.
 * @returns The origin of the URL, or "UNKNOWN" if the URL is invalid.
 */
export function getOriginFromURL(url: string): string {
  try {
    return new URL(url).origin;
  } catch (e) {
    return "UNKNOWN";
  }
}
