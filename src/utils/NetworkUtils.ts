import { PublicNetworks } from "@uma/common";
import { PRODUCTION_CHAIN_IDS, TESTNET_CHAIN_IDS } from "../constants";

/**
 * A list of networks that provide more resolution about a chainid -> network name
 */
const networkIdMap: Record<number, string> = {
  666: "Hardhat1",
  1337: "Hardhat2",
  421613: "ArbitrumGoerli",
  324: "ZkSync",
  280: "ZkSync-Goerli",
  8453: "Base",
  84531: "BaseGoerli",
  84532: "BaseSepolia",
  11155111: "EthSepolia",
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
  return [10, 8453, 69, 420, 84531].includes(chainId);
}
