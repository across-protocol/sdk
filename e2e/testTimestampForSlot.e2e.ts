#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */

import { program } from "commander";
import winston from "winston";
import { ClusterUrl } from "@solana/kit";
import { getNearestSlotTime } from "../src/arch/svm/utils";
import { FallbackSolanaRpcFactory, CachedSolanaRpcFactory } from "../src/providers";

/**
 * USAGE EXAMPLES:
 *
 * Basic usage (default settings):
 *   npx ts-node testTimestampForSlot.e2e.ts
 *
 * Test with specific endpoint:
 *   npx ts-node testTimestampForSlot.e2e.ts -e https://api.devnet.solana.com
 *
 * Test with fallback endpoints:
 *   npx ts-node testTimestampForSlot.e2e.ts -e https://api.mainnet-beta.solana.com -f https://api.devnet.solana.com https://api.testnet.solana.com
 *
 * Test with more iterations:
 *   npx ts-node testTimestampForSlot.e2e.ts -n 20
 */

// Configure winston logger
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
  fallbackEndpoints: string[];
  retries: number;
  retryDelay: number;
  chainId: number;
  iterations: number;
  quorumThreshold: number;
}

async function testNearestSlotTime(
  rpcClient: any,
  iteration: number
): Promise<{
  iteration: number;
  slot: string;
  success: boolean;
  timestamp?: number;
  time: number;
  error?: string;
}> {
  console.log(`--- Iteration ${iteration} ---`);
  const startTime = Date.now();

  try {
    const { slot, timestamp } = await getNearestSlotTime(rpcClient);
    const elapsedTime = Date.now() - startTime;

    console.log(`✅ Slot ${slot} -> ${timestamp} (${new Date(timestamp * 1000).toISOString()}) (${elapsedTime}ms)`);
    return {
      iteration,
      slot: slot.toString(),
      success: true,
      timestamp,
      time: elapsedTime,
    };
  } catch (error: unknown) {
    const elapsedTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
    console.log(`❌ Failed (${elapsedTime}ms):`, error);
    return {
      iteration,
      slot: "unknown",
      success: false,
      error: errorMsg,
      time: elapsedTime,
    };
  }
}

async function runTest(options: TestOptions) {
  console.log("🚀 Starting getNearestSlotTime E2E Test");
  console.log("Configuration:", {
    endpoint: options.endpoint,
    fallbackEndpoints: options.fallbackEndpoints,
    retries: options.retries,
    retryDelay: options.retryDelay,
    iterations: options.iterations,
    quorumThreshold: options.quorumThreshold,
  });

  // Create the RPC factory
  const allEndpoints = [options.endpoint, ...options.fallbackEndpoints];
  const factoryParams = allEndpoints.map(
    (endpoint) =>
      [
        "test-timestamp-for-slot",
        undefined, // redisClient
        options.retries,
        options.retryDelay,
        10, // maxConcurrency
        0, // pctRpcCallsLogged
        logger,
        endpoint as ClusterUrl,
        options.chainId,
      ] as ConstructorParameters<typeof CachedSolanaRpcFactory>
  );

  const rpcFactory = new FallbackSolanaRpcFactory(factoryParams, options.quorumThreshold, logger);

  const rpcClient = rpcFactory.createRpcClient();

  console.log(`\n📡 Running ${options.iterations} sequential tests...\n`);

  const testStartTime = Date.now();
  const results: Array<{
    iteration: number;
    slot: string;
    success: boolean;
    timestamp?: number;
    time: number;
    error?: string;
  }> = [];

  for (let i = 0; i < options.iterations; i++) {
    const result = await testNearestSlotTime(rpcClient, i + 1);
    results.push(result);
  }

  const totalTime = Date.now() - testStartTime;

  // Print summary
  console.log("\n📊 Test Summary:");
  console.log("================");
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const retried = results.filter((r) => r.time > 1000); // We know an attempt retried if it took > 1 second
  const retryCount = retried.length;
  const retriedSuccessfully = retried.filter((r) => r.success).length;
  const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
  const longestTime = results.reduce((max, r) => Math.max(max, r.time), 0);
  const retriedAvgTime = retried.reduce((sum, r) => sum + r.time, 0) / retried.length;
  const retriedLongestTime = retried.reduce((max, r) => Math.max(max, r.time), 0);

  console.log(`Successful: ${successful} / ${options.iterations}`);
  console.log(`Failed: ${failed} / ${options.iterations}`);
  console.log(`Average time per call: ${avgTime.toFixed(0)}ms`);
  console.log(`Longest time per call: ${longestTime.toFixed(0)}ms`);
  console.log(`Retried: ${retryCount} / ${options.iterations}`);
  console.log(`Retried successfully: ${retriedSuccessfully} / ${retryCount}`);
  console.log(`Retried unsuccessfully: ${retryCount - retriedSuccessfully} / ${retryCount}`);
  console.log(`Retried average time: ${retriedAvgTime.toFixed(0)}ms`);
  console.log(`Retried longest time: ${retriedLongestTime.toFixed(0)}ms`);
  console.log(`Total test time: ${totalTime}ms`);

  if (failed > 0) {
    console.log("\n❌ Failed tests:");
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  Iteration ${r.iteration}: ${r.error}`);
      });

    // Show error patterns
    const errorPatterns = new Map<string, number>();
    results
      .filter((r) => !r.success && r.error)
      .forEach((r) => {
        const errorType = r.error!.split(":")[0].trim();
        errorPatterns.set(errorType, (errorPatterns.get(errorType) || 0) + 1);
      });

    console.log("\n🔍 Error patterns:");
    errorPatterns.forEach((count, pattern) => {
      console.log(`  ${pattern}: ${count} occurrences`);
    });
  }
}

// CLI setup
program
  .name("test-timestamp-for-slot")
  .description("Test getNearestSlotTime function (which calls getTimestampForSlot internally)");

program
  .option("-e, --endpoint <url>", "Solana RPC endpoint URL", "https://api.mainnet-beta.solana.com")
  .option("-f, --fallback-endpoints <urls...>", "Fallback RPC endpoint URLs (space-separated)")
  .option("-r, --retries <number>", "Number of retries on failure", "2")
  .option("-d, --retry-delay <seconds>", "Delay between retries in seconds", "1")
  .option("-i, --chain-id <number>", "Chain ID for Solana", "101")
  .option("-n, --iterations <number>", "Number of test iterations", "10")
  .option("-q, --quorum-threshold <number>", "Quorum threshold for RPC calls", "1")
  .action(async (options) => {
    const testOptions: TestOptions = {
      endpoint: options.endpoint,
      fallbackEndpoints: options.fallbackEndpoints || [],
      retries: parseInt(options.retries),
      retryDelay: parseFloat(options.retryDelay),
      chainId: parseInt(options.chainId),
      iterations: parseInt(options.iterations),
      quorumThreshold: parseInt(options.quorumThreshold),
    };

    await runTest(testOptions);
  });

program.parse();
