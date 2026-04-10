import { existsSync } from "fs";

export function loadEnv(path = ".env"): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
