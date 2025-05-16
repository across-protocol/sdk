import { spawn } from "child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { SvmSpokeClient } from "@across-protocol/contracts";

const LEDGER_DIR = path.resolve(__dirname, "..", ".ledger");

export const validatorSetup = async () => {
  // Always start with a clean ledger
  await fs.rm(LEDGER_DIR, { recursive: true, force: true });

  const args = [
    "--clone-upgradeable-program",
    SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
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

export const validatorTeardown = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pid = (global as any).__SOLANA_VALIDATOR_PID__;
  if (pid) {
    process.kill(pid);
    return;
  }
};
