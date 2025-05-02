import { spawn } from "child_process";
import path from "node:path";
import fs from "node:fs/promises";

const LEDGER_DIR = path.resolve(__dirname, "..", ".ledger");

export default async () => {
  // Always start with a clean ledger
  await fs.rm(LEDGER_DIR, { recursive: true, force: true });

  const args = [
    "--clone-upgradeable-program",
    "JAZWcGrpSWNPTBj8QtJ9UyQqhJCDhG9GJkDeMf5NQBiq",
    "--clone",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "--url",
    "https://api.mainnet-beta.solana.com",
    "--ledger",
    LEDGER_DIR,
    "--reset",
  ];

  const proc = spawn("solana-test-validator", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    proc.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes("JSON RPC URL")) resolve();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => reject(new Error(`validator exited early with code ${code}`)));
  });

  // expose the pid for teardown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__SOLANA_VALIDATOR_PID__ = proc.pid;
};
