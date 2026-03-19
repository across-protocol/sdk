import { build } from "esbuild";
import path from "path";

const NODE_BUILTINS = [
  "fs",
  "fs/promises",
  "path",
  "os",
  "crypto",
  "stream",
  "http",
  "https",
  "net",
  "tls",
  "zlib",
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "readline",
  "repl",
  "tty",
  "v8",
  "vm",
  "worker_threads",
  "perf_hooks",
  "node:perf_hooks",
  "node:crypto",
  "node:fs",
  "node:path",
];

const FORBIDDEN_PACKAGES = ["winston", "@pinata/sdk", "winston-transport"];

async function verifyBrowserSafety() {
  const entryPoint = path.resolve(__dirname, "../dist/esm/src/browser.js");
  const resolvedNodeModules: string[] = [];

  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
      external: [
        "@across-protocol/contracts",
        "@across-protocol/constants",
        "@across-protocol/across-token",
        "@coral-xyz/anchor",
        "@eth-optimism/sdk",
        "@eth-optimism/sdk/*",
        "@ethersproject/*",
        "@solana/*",
        "@solana-program/*",
        "@nktkas/hyperliquid",
        "ethers",
        "ethers/*",
        "viem",
        "viem/*",
        "axios",
        "arweave",
        "lodash",
        "lodash.get",
        "decimal.js",
        "bs58",
        "superstruct",
        "tslib",
        "async",
        "assert",
        "node-gyp",
        "bigint-buffer",
      ],
      plugins: [
        {
          name: "detect-node-builtins",
          setup(pluginBuild) {
            const allForbidden = [...NODE_BUILTINS, ...FORBIDDEN_PACKAGES];
            const filter = new RegExp(
              `^(node:|${allForbidden.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
            );

            pluginBuild.onResolve({ filter }, (args) => {
              resolvedNodeModules.push(`${args.path} (imported by ${args.importer})`);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
  } catch (e) {
    console.error("esbuild failed:", e);
    process.exit(1);
  }

  if (resolvedNodeModules.length > 0) {
    console.error("Browser entrypoint resolved Node-only modules:");
    for (const mod of Array.from(new Set(resolvedNodeModules))) {
      console.error(`  - ${mod}`);
    }
    process.exit(1);
  }

  console.log("Browser safety check passed: no Node-only modules resolved.");
}

void verifyBrowserSafety();
