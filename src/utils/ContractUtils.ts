import * as typechain from "@across-protocol/contracts/dist/typechain"; // Import the typechain module

export function getParamType(contractName: string, functionName: string, paramName: string): string {
  const artifact = typechain[`${[contractName]}__factory`];
  const fragment = artifact.abi.find((fragment: { name: string }) => fragment.name === functionName);
  return fragment?.inputs.find((input: { name: string }) => input.name === paramName) || "";
}
