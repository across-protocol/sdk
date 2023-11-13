import { PublicNetworks } from "@uma/common/dist/PublicNetworks";

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
    if (Number(networkId) == 666) {
      return "Hardhat1";
    }
    if (Number(networkId) == 1337) {
      return "Hardhat2";
    }
    if (Number(networkId) == 421613) {
      return "ArbitrumGoerli";
    }
    if (Number(networkId) == 324) {
      return "ZkSync";
    }
    if (Number(networkId) == 280) {
      return "ZkSync-Goerli";
    }
    if (Number(networkId) == 8453) {
      return "Base";
    }
    if (Number(networkId) == 84531) {
      return "BaseGoerli";
    }
    return "unknown";
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
  return [1, 10, 137, 324, 8453, 42161].includes(chainId);
}

/**
 * Determines whether a chain ID is part of the production network.
 * @param chainId Chain ID to query.
 * @returns true if the chain ID is part of the production network, otherwise false.
 */
export function chainIsTestnet(chainId: number): boolean {
  return [5, 280, 420, 80001, 84531, 421613].includes(chainId);
}

/**
 * Determines whether a chain ID is an Optimism OP Stack implementation.
 * @param chainId Chain ID to evaluate.
 * @returns True if chainId is an OP stack, otherwise false.
 */
export function chainIsOPStack(chainId: number): boolean {
  return [10, 8453, 69, 420, 84531].includes(chainId);
}
