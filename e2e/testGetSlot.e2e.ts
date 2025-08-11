#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */

import { program } from "commander";
import winston from "winston";
import { ClusterUrl, type Commitment } from "@solana/kit";
import { getSlot } from "../src/arch/svm/SpokeUtils";
import { CachedSolanaRpcFactory, QuorumFallbackSolanaRpcFactory } from "../src/providers/solana";

/**
 * USAGE EXAMPLES:
 *
 * Basic usage (default settings):
 *   npx ts-node testGetSlot.e2e.ts
 *
 * Test with specific endpoint:
 *   npx ts-node testGetSlot.e2e.ts -e https://api.devnet.solana.com
 *
 * Test with more iterations:
 *   npx ts-node testGetSlot.e2e.ts -n 20
 *
 * Test with different commitment level:
 *   npx ts-node testGetSlot.e2e.ts -c finalized
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
  commitment: Commitment;
  quorumThreshold: number;
}

async function testGetSlot(
  rpcClient: any,
  commitment: Commitment,
  iteration: number
): Promise<{
  iteration: number;
  slot: string;
  success: boolean;
  commitment: Commitment;
  time: number;
  error?: string;
}> {
  console.log(`--- Iteration ${iteration} (commitment: ${commitment}) ---`);
  const startTime = Date.now();

  try {
    const slot = await getSlot(rpcClient, commitment, logger);
    const elapsedTime = Date.now() - startTime;

    console.log(`✅ Slot ${slot.toString()} (commitment: ${commitment}) (${elapsedTime}ms)`);
    return {
      iteration,
      slot: slot.toString(),
      success: true,
      commitment,
      time: elapsedTime,
    };
  } catch (error: unknown) {
    const elapsedTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`❌ Failed: ${errorMsg} (${elapsedTime}ms)`);
    return {
      iteration,
      slot: "unknown",
      success: false,
      commitment,
      error: errorMsg,
      time: elapsedTime,
    };
  }
}

async function runTest(options: TestOptions) {
  console.log("🚀 Starting getSlot E2E Test");
  console.log("Configuration:", {
    endpoint: options.endpoint,
    fallbackEndpoints: options.fallbackEndpoints,
    retries: options.retries,
    retryDelay: options.retryDelay,
    iterations: options.iterations,
    quorumThreshold: options.quorumThreshold,
    commitment: options.commitment,
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
  const rpcFactory = new QuorumFallbackSolanaRpcFactory(factoryParams, options.quorumThreshold, logger);


  const rpcClient = rpcFactory.createRpcClient();

  console.log(`\n📡 Running ${options.iterations} sequential tests...\n`);

  const testStartTime = Date.now();
  const results: Array<{
    iteration: number;
    slot: string;
    success: boolean;
    commitment: Commitment;
    time: number;
    error?: string;
  }> = [];

  for (let i = 0; i < options.iterations; i++) {
    const result = await testGetSlot(rpcClient, options.commitment, i + 1);
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
program.name("test-get-slot").description("Test getSlot function with configurable commitment parameter");

program
  .option("-e, --endpoint <url>", "Solana RPC endpoint URL", "https://api.mainnet-beta.solana.com")
  .option("-f, --fallback-endpoints <urls...>", "Fallback RPC endpoint URLs (space-separated)")
  .option("-r, --retries <number>", "Number of retries on failure", "2")
  .option("-d, --retry-delay <seconds>", "Delay between retries in seconds", "1")
  .option("-i, --chain-id <number>", "Chain ID for Solana", "101")
  .option("-n, --iterations <number>", "Number of test iterations", "10")
  .option("-c, --commitment <commitment>", "Commitment level (processed, confirmed, finalized)", "confirmed")
  .option("-q, --quorum-threshold <number>", "Quorum threshold for RPC calls", "1")
  .action(async (options) => {
    // Validate commitment parameter
    const validCommitments: Commitment[] = ["processed", "confirmed", "finalized"];
    if (!validCommitments.includes(options.commitment as Commitment)) {
      console.error(`Invalid commitment level: ${options.commitment}. Valid options: ${validCommitments.join(", ")}`);
      process.exit(1);
    }

    const testOptions: TestOptions = {
      endpoint: options.endpoint,
      fallbackEndpoints: options.fallbackEndpoints || [],
      retries: parseInt(options.retries),
      retryDelay: parseFloat(options.retryDelay),
      chainId: parseInt(options.chainId),
      iterations: parseInt(options.iterations),
      commitment: options.commitment as Commitment,
      quorumThreshold: parseInt(options.quorumThreshold),
    };

    await runTest(testOptions);
  });

program.parse();
