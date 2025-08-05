#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */

import { program } from "commander";
import winston from "winston";
import { ClusterUrl } from "@solana/kit";
import { FallbackSolanaRpcFactory } from "../src/providers";

/**
 * USAGE EXAMPLES:
 *
 * Basic usage (default settings):
 *   npx ts-node solanaProvider.e2e.ts
 *
 * Test with specific endpoint and method:
 *   npx ts-node solanaProvider.e2e.ts -e https://api.devnet.solana.com -m getVersion
 *
 * Stress test with multiple iterations:
 *   npx ts-node solanaProvider.e2e.ts -n 20 -m getSlot
 *
 * Test retry logic with high retry settings:
 *   npx ts-node solanaProvider.e2e.ts -r 5 -d 2 -m getLatestBlockhash
 *
 * Test different RPC methods:
 *   npx ts-node solanaProvider.e2e.ts -m getHealth
 *   npx ts-node solanaProvider.e2e.ts -m getEpochInfo
 *   npx ts-node solanaProvider.e2e.ts -m getBlockTime
 *
 * Test with devnet:
 *   npx ts-node solanaProvider.e2e.ts -e https://api.devnet.solana.com -i 103
 *
 * Test with testnet:
 *   npx ts-node solanaProvider.e2e.ts -e https://api.testnet.solana.com -i 102
 *
 * Load testing scenario:
 *   npx ts-node solanaProvider.e2e.ts -n 50 -c 20 -m getSlot
 *
 * List available methods:
 *   npx ts-node solanaProvider.e2e.ts list-methods
 *
 * Show usage examples:
 *   npx ts-node solanaProvider.e2e.ts examples
 */

// Configure winston logger for better output
const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
      return `${timestamp} [${level}]: ${message} ${metaStr}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

interface TestOptions {
  endpoint: string;
  retries: number;
  retryDelay: number;
  chainId: number;
  method: string;
  iterations: number;
}

// Test scenarios for different RPC methods
const TEST_SCENARIOS = {
  getSlot: async (client: any) => {
    console.log("Testing getSlot...");
    const result = await client.getSlot({ commitment: "confirmed" }).send();
    return { method: "getSlot", result: result.toString() };
  },

  getLatestBlockhash: async (client: any) => {
    console.log("Testing getLatestBlockhash...");
    const result = await client.getLatestBlockhash({ commitment: "confirmed" }).send();
    return { method: "getLatestBlockhash", result: result.value.blockhash };
  },

  getVersion: async (client: any) => {
    console.log("Testing getVersion...");
    const result = await client.getVersion().send();
    return { method: "getVersion", result: result };
  },

  getHealth: async (client: any) => {
    console.log("Testing getHealth...");
    const result = await client.getHealth().send();
    return { method: "getHealth", result: result || "OK" };
  },

  getBlockTime: async (client: any) => {
    console.log("Testing getBlockTime with latest slot...");
    // First get the latest slot
    const slot = await client.getSlot({ commitment: "confirmed" }).send();
    const result = await client.getBlockTime(slot).send();
    return { method: "getBlockTime", result: result?.toString() || "null" };
  },

  getEpochInfo: async (client: any) => {
    console.log("Testing getEpochInfo...");
    const result = await client.getEpochInfo().send();
    return { method: "getEpochInfo", result: `Epoch ${result.epoch}, Slot ${result.slotIndex}/${result.slotsInEpoch}` };
  },
};

async function runTest(options: TestOptions) {
  console.log("🚀 Starting Retry RPC Factory Test");
  console.log("Configuration:", {
    endpoint: options.endpoint,
    retries: options.retries,
    retryDelay: options.retryDelay,
    method: options.method,
    iterations: options.iterations,
  });

  // Create the retry RPC factory
  const rpcFactory = new FallbackSolanaRpcFactory(
    [
      [
        "script-e2e-solana-provider",
        undefined, // redisClient, unused for now
        options.retries, // retries
        options.retryDelay, // retryDelaySeconds
        10, // maxConcurrency
        0, // pctRpcCallsLogged
        logger, // logger
        options.endpoint as ClusterUrl, // clusterUrl
        options.chainId,
      ],
    ],
    1
  );

  // Create RPC client
  const rpcClient = rpcFactory.createRpcClient();

  // Select test scenario
  const testScenario = TEST_SCENARIOS[options.method as keyof typeof TEST_SCENARIOS];
  if (!testScenario) {
    throw new Error(`Unknown test method: ${options.method}. Available: ${Object.keys(TEST_SCENARIOS).join(", ")}`);
  }

  console.log(`\n📡 Running ${options.iterations} iteration(s) of ${options.method}...\n`);

  // Run the test iterations
  const results: Array<{
    iteration: number;
    success: boolean;
    time: number;
    result?: string;
    error?: string;
  }> = [];
  const startTime = Date.now();

  for (let i = 0; i < options.iterations; i++) {
    console.log(`--- Iteration ${i + 1}/${options.iterations} ---`);
    const iterationStart = Date.now();
    try {
      const result = await testScenario(rpcClient);
      const iterationTime = Date.now() - iterationStart;
      console.log(`✅ Success: ${JSON.stringify(result.result)} (${iterationTime}ms)`);
      results.push({ iteration: i + 1, success: true, result: result.result, time: iterationTime });
    } catch (error: unknown) {
      const iterationTime = Date.now() - iterationStart;
      console.log(`❌ Failed: ${error instanceof Error ? error.message : String(error)} (${iterationTime}ms)`);
      results.push({
        iteration: i + 1,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        time: iterationTime,
      });
    }

    // Add a small delay between iterations
    if (i < options.iterations - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const totalTime = Date.now() - startTime;

  // Print summary
  console.log("\n📊 Test Summary:");
  console.log("================");
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
  const longestTime = results.reduce((max, r) => Math.max(max, r.time), 0);

  console.log(`Total iterations: ${options.iterations}`);
  console.log(`Successful: ${successful} (${((successful / options.iterations) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} (${((failed / options.iterations) * 100).toFixed(1)}%)`);
  console.log(`Average time per call: ${avgTime.toFixed(0)}ms`);
  console.log(`Longest time per call: ${longestTime.toFixed(0)}ms`);
  console.log(`Total test time: ${totalTime}ms`);

  if (failed > 0) {
    console.log("\n❌ Failed iterations:");
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  Iteration ${r.iteration}: ${r.error}`);
      });
  }
}

// CLI setup
program.name("solana-provider-e2e").description("Test the Solana Retry RPC Factory with configurable parameters");

program
  .option("-e, --endpoint <url>", "Solana RPC endpoint URL", "https://api.mainnet-beta.solana.com")
  .option("-r, --retries <number>", "Number of retries on failure", "3")
  .option("-d, --retry-delay <seconds>", "Delay between retries in seconds", "1")
  .option("-c, --max-concurrency <number>", "Maximum concurrent requests", "10")
  .option("-l, --log-percentage <number>", "Percentage of RPC calls to log (0-100)", "100")
  .option("-i, --chain-id <number>", "Chain ID for Solana", "101")
  .option("-m, --method <method>", "RPC method to test", "getSlot")
  .option("-n, --iterations <number>", "Number of test iterations", "5")
  .option("-f, --simulate-failures", "Simulate network failures to test retry logic", false)
  .option("-p, --failure-rate <rate>", "Failure simulation rate (0.0-1.0)", "0.5")
  .action(async (options) => {
    const testOptions: TestOptions = {
      endpoint: options.endpoint,
      retries: parseInt(options.retries),
      retryDelay: parseFloat(options.retryDelay),
      chainId: parseInt(options.chainId),
      method: options.method,
      iterations: parseInt(options.iterations),
    };

    await runTest(testOptions);
  });

// Add a command to list available test methods
program
  .command("list-methods")
  .description("List available RPC methods for testing")
  .action(() => {
    console.log("Available test methods:");
    Object.keys(TEST_SCENARIOS).forEach((method) => {
      console.log(`  - ${method}`);
    });
  });

// Parse command line arguments
program.parse();
