#!/usr/bin/env node
/**
 * Smoke test: every entrypoint under dist/esm should load under Node's strict
 * ESM resolver. Run after a fresh build to catch regressions where dist
 * import specifiers go stale (missing .js extension, named import from a CJS
 * dep, etc.) — the exact failure mode that bit the dapp on @across-protocol/sdk
 * 4.3.154 under Vite SSR.
 *
 * Add new entry paths here whenever a downstream consumer reports a fresh
 * import chain failure.
 */
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");

const ROOT = resolve(__dirname, "..");

const entryPoints = [
  "dist/esm/src/index.js",
  "dist/esm/src/addressAggregator/index.js",
  "dist/esm/src/arch/evm/BlockUtils.js",
  "dist/esm/src/arch/svm/BlockUtils.js",
  "dist/esm/src/arch/svm/SpokeUtils.js",
  "dist/esm/src/arch/svm/eventsClient.js",
  "dist/esm/src/clients/HubPoolClient.js",
  "dist/esm/src/clients/mocks/MockEvents.js",
  "dist/esm/src/clients/mocks/MockSpokePoolClient.js",
  "dist/esm/src/clients/mocks/MockSvmCpiEventsClient.js",
  "dist/esm/src/contracts/index.js",
  "dist/esm/src/merkleDistributor/model/index.js",
  "dist/esm/src/priceClient/index.js",
  "dist/esm/src/providers/cachedProvider.js",
  "dist/esm/src/providers/utils.js",
  "dist/esm/src/typechain.js",
];

async function main() {
  let failed = 0;
  for (const rel of entryPoints) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`MISSING  ${rel}`);
      failed++;
      continue;
    }
    try {
      await import(pathToFileURL(abs).href);
      console.log(`OK       ${rel}`);
    } catch (err) {
      failed++;
      console.error(`FAIL     ${rel}`);
      console.error(`         ${err.code || ""} ${err.message.split("\n")[0]}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} / ${entryPoints.length} entry points failed to import.`);
    process.exit(1);
  }
  console.log(`\nAll ${entryPoints.length} entry points imported cleanly.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
