import { PublicNetworks } from "@uma/common/dist/PublicNetworks";
import { CHAIN_IDs, PRODUCTION_CHAIN_IDS, TESTNET_CHAIN_IDS } from "../constants";
import { MAINNET_CHAIN_IDs } from "@across-protocol/constants-v2";
import { isDefined } from "./TypeGuards";

/**
 * A list of networks that provide more resolution about a chainid -> network name
 */
const networkIdMap: Record<number, string> = {
  666: "Hardhat1",
  1337: "Hardhat2",
  421613: "ArbitrumGoerli",
  421614: "ArbitrumSepolia",
  324: "ZkSync",
  280: "ZkSync-Goerli",
  300: "ZKSync-Sepolia",
  8453: "Base",
  84531: "BaseGoerli",
  84532: "BaseSepolia",
  11155111: "EthSepolia",
  11155420: "OptimismSepolia",
};

/**
 * Resolves a network name from a network id.
 * @param networkId The network id to resolve the name for
 * @returns The network name for the network id. If the network id is not found, returns "unknown"
 */
export function getNetworkName(networkId: number | string): string {
  try {
    const networkName = PublicNetworks[Number(networkId)].name;
    return networkName.charAt(0).toUpperCase() + networkName.slice(1);
  } catch (error) {
    // Convert networkId to a number in case it's a string, then lookup in the map
    // Return "unknown" if the networkId does not exist in the map
    return networkIdMap[Number(networkId)] || "unknown";
  }
}

/**
 * Resolves a native token symbol from a chain id.
 * @param chainId The chain id to resolve the native token symbol for
 * @returns The native token symbol for the chain id. If the chain id is not found, returns "ETH"
 */
export function getNativeTokenSymbol(chainId: number | string): string {
  if (chainId.toString() === "137" || chainId.toString() === "80001") {
    return "MATIC";
  }
  return "ETH";
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
 * Determines whether a chainId is associated with another chainId. This is useful for determining if a chainId is associated with a mainnet implementation.
 * @param mainnetChainId The mainnet chainId to check if the chainId is associated with.
 * @param chainId The chainId to check if it is associated with the mainnetChainId.
 * @param stackAssociations If true, will check for associations between stack implementations. Default is false. Currently only used for OP stack implementations.
 * @returns True if the chainId is associated with the mainnetChainId, otherwise false.
 * @throws If the mainnetChainId is not a valid mainnetChainId.
 * @example chainIsAssociatedWith(CHAIN_IDs.MAINNET, CHAIN_IDs.GOERLI) // true
 * @example chainIsAssociatedWith(CHAIN_IDs.SEPOLIA, CHAIN_IDs.GOERLI) // throws <- Sepolia is not a mainnet implementation
 * @example chainIsAssociatedWith(CHAIN_IDs.OPTIMISM, CHAIN_IDs.OPTIMISM_GOERLI, true) // true <- Optimism is associated with its testnet implementations
 * @example chainIsAssociatedWith(CHAIN_IDs.OPTIMISM, CHAIN_IDs.BASE) // false <- Optimism is not associated with Base
 * @example chainIsAssociatedWith(CHAIN_IDs.OPTIMISM, CHAIN_IDs.BASE, true) // true <- Optimism is associated with Base via the OP stack
 */
export function chainIsAssociatedWith(mainnetChainId: number, chainId: number, stackAssociations = false): boolean {
  if (mainnetChainId === chainId) {
    // BaseCase: a chain is always associated with itself
    return true;
  }
  // Define a list of loose associations between chainIds. Primarily between main/testnet implementations
  const associations = {
    [MAINNET_CHAIN_IDs.OPTIMISM]: [CHAIN_IDs.OPTIMISM_GOERLI, CHAIN_IDs.OPTIMISM_SEPOLIA],
    [MAINNET_CHAIN_IDs.BASE]: [CHAIN_IDs.BASE_GOERLI, CHAIN_IDs.BASE_SEPOLIA],
    [MAINNET_CHAIN_IDs.ARBITRUM]: [CHAIN_IDs.ARBITRUM_GOERLI, CHAIN_IDs.ARBITRUM_SEPOLIA],
    [MAINNET_CHAIN_IDs.ZK_SYNC]: [CHAIN_IDs.ZK_SYNC_GOERLI, CHAIN_IDs.ZK_SYNC_SEPOLIA],
    [MAINNET_CHAIN_IDs.ARBITRUM]: [CHAIN_IDs.ARBITRUM_GOERLI, CHAIN_IDs.ARBITRUM_SEPOLIA],
    [MAINNET_CHAIN_IDs.MAINNET]: [CHAIN_IDs.GOERLI, CHAIN_IDs.SEPOLIA],
    [MAINNET_CHAIN_IDs.POLYGON]: [CHAIN_IDs.MUMBAI, CHAIN_IDs.POLYGON_AMOY],
    [MAINNET_CHAIN_IDs.LINEA]: [CHAIN_IDs.LINEA_GOERLI],
    [MAINNET_CHAIN_IDs.BOBA]: [], // Added for completeness. Boba is not associated with any testnet in our system
  };
  if (!isDefined(associations[mainnetChainId])) {
    throw new Error(
      `Must pass a valid mainnetChainId as the first param. ${mainnetChainId} is not a valid mainnetChainId.`
    );
  }
  // This call implies that the chainId is a testnet implementation of the associatedChainId
  if (associations[mainnetChainId]?.includes(chainId)) {
    return true;
  }
  // We currently only have associations for OP stack implementations.
  if (stackAssociations) {
    const opStack = [
      CHAIN_IDs.OPTIMISM,
      CHAIN_IDs.BASE,
      CHAIN_IDs.OPTIMISM_GOERLI,
      CHAIN_IDs.BASE_GOERLI,
      CHAIN_IDs.OPTIMISM_SEPOLIA,
      CHAIN_IDs.BASE_SEPOLIA,
    ];
    if (opStack.includes(mainnetChainId) && opStack.includes(chainId)) {
      return true;
    }
  }
  // If we make it to this point, the chainId is not associated with the associatedChainId
  return false;
}
