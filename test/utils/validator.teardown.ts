import process from "node:process";

export default () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pid = (global as any).__SOLANA_VALIDATOR_PID__;
  if (pid) {
    process.kill(pid);
    return;
  }
};
