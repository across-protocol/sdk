const fs = require("fs");
const path = require("path");

const CONTRACTS_OUT_DIR = "node_modules/@across-protocol/contracts/out";
const STAGE_DIR = "src/utils/abi/contracts";


// Patterns to exclude (mocks, tests, scripts)
const EXCLUDE_PATTERNS = [
  /Mock/i,
  /Stub/i,
  /\.t$/,   // Foundry test files (ContractName.t.sol)
  /\.s$/,   // Foundry script files (ContractName.s.sol)
];

function shouldExclude(contractName) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(contractName));
}

function main() {
  if (!fs.existsSync(CONTRACTS_OUT_DIR)) {
    console.error(`Error: ${CONTRACTS_OUT_DIR} not found. Run yarn install first.`);
    process.exit(1);
  }

  if (!fs.existsSync(STAGE_DIR)) {
    fs.mkdirSync(STAGE_DIR, { recursive: true });
  }

  // Discover all contract directories
  const entries = fs.readdirSync(CONTRACTS_OUT_DIR, { withFileTypes: true });
  const contractDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".sol"))
    .map((entry) => entry.name.replace(".sol", ""));

  let stagedCount = 0;
  let skippedCount = 0;

  for (const contractName of contractDirs) {
    // Skip mocks, tests, and scripts
    if (shouldExclude(contractName)) {
      skippedCount++;
      continue;
    }

    const solDir = path.join(CONTRACTS_OUT_DIR, `${contractName}.sol`);
    const jsonFiles = fs.readdirSync(solDir).filter((f) => f.endsWith(".json"));

    for (const jsonFile of jsonFiles) {
      const innerName = jsonFile.replace(".json", "");
      if (shouldExclude(innerName)) {
        skippedCount++;
        continue;
      }

      const sourcePath = path.join(solDir, jsonFile);
      const destPath = path.join(STAGE_DIR, jsonFile);

      try {
        const artifact = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
        // Only stage if it has an ABI with content
        if (artifact.abi && artifact.abi.length > 0) {
          fs.writeFileSync(destPath, JSON.stringify(artifact.abi, null, 2));
          stagedCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        console.error(`Error processing ${innerName}: ${err.message}`);
        throw err;
      }
    }
  }

  console.log(`Staged ${stagedCount} contracts, skipped ${skippedCount}`);
}

main();
