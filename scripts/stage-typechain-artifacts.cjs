const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CONTRACTS_ABI_DIR = "node_modules/@across-protocol/contracts/dist/evm/artifacts";
const STAGE_DIR = "src/utils/abi/contracts";
const TYPECHAIN_DIR = "src/utils/abi/typechain";

// Patterns to exclude (mocks, tests, scripts)
const EXCLUDE_PATTERNS = [
  /Mock/i,
  /Stub/i,
  /\.t$/, // Foundry test files (ContractName.t.sol)
  /\.s$/, // Foundry script files (ContractName.s.sol)
];

function shouldExclude(contractName) {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(contractName));
}

// Copy contract ABIs out of the installed @across-protocol/contracts package into STAGE_DIR
// so typechain has a stable, filtered set of inputs to generate bindings from.
function stageArtifacts() {
  if (!fs.existsSync(CONTRACTS_ABI_DIR)) {
    console.error(`Error: ${CONTRACTS_ABI_DIR} not found. Run yarn install first.`);
    process.exit(1);
  }

  if (!fs.existsSync(STAGE_DIR)) {
    fs.mkdirSync(STAGE_DIR, { recursive: true });
  }

  // Discover all contract directories
  const entries = fs.readdirSync(CONTRACTS_ABI_DIR, { withFileTypes: true });
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

    const solDir = path.join(CONTRACTS_ABI_DIR, `${contractName}.sol`);
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

// Generate ethers-v5 typechain bindings from the staged ABIs. We invoke the local
// typechain binary directly (rather than relying on PATH) so this works whether the
// script is run via `yarn typechain` or directly with `node`.
function generateTypechain() {
  const typechainBin = path.join("node_modules", ".bin", "typechain");
  execFileSync(
    typechainBin,
    ["--target", "ethers-v5", "--out-dir", TYPECHAIN_DIR, `${STAGE_DIR}/*.json`],
    { stdio: "inherit" }
  );
}

// Typechain occasionally emits unused type imports (e.g. struct types in factories),
// which trip TS noUnusedLocals/noUnusedParameters during the build. These bindings are
// generated, not hand-maintained, so stamp `// @ts-nocheck` onto each freshly generated
// file to suppress type checking for them.
function patchFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("@ts-nocheck")) {
    return false;
  }

  const patched = content.replace(/(\/\* eslint-disable \*\/\n)/, `$1// @ts-nocheck\n`);
  if (patched === content) {
    return false;
  }

  fs.writeFileSync(filePath, patched);
  return true;
}

function patchTypechain() {
  let patchedCount = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".ts") && patchFile(full)) {
        patchedCount++;
      }
    }
  };
  walk(TYPECHAIN_DIR);
  console.log(`Patched ${patchedCount} typechain files with @ts-nocheck`);
}

function main() {
  stageArtifacts();
  generateTypechain();
  patchTypechain();
}

main();