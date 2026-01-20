const fs = require("fs");
const path = require("path");

const CONTRACTS_OUT_DIR = "node_modules/@across-protocol/contracts/out";
const STAGE_DIR = "src/utils/abi/contracts";

// Contracts to generate from Foundry artifacts
const FOUNDRY_CONTRACTS = [
  "SpokePool",
  "HubPool",
  "AcrossConfigStore",
  "AcrossMerkleDistributor",
  "ERC20",
];

// Contracts that already exist locally (don't overwrite)
const LOCAL_CONTRACTS = ["Multicall3"];

function main() {
  if (!fs.existsSync(STAGE_DIR)) {
    fs.mkdirSync(STAGE_DIR, { recursive: true });
  }

  for (const contractName of FOUNDRY_CONTRACTS) {
    const sourcePath = path.join(
      CONTRACTS_OUT_DIR,
      `${contractName}.sol`,
      `${contractName}.json`
    );
    const destPath = path.join(STAGE_DIR, `${contractName}.json`);

    if (fs.existsSync(sourcePath)) {
      const artifact = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      fs.writeFileSync(destPath, JSON.stringify(artifact.abi, null, 2));
      console.log(`Staged: ${contractName}`);
    } else {
      console.error(`Error: ${sourcePath} not found`);
      process.exit(1);
    }
  }
}

main();
