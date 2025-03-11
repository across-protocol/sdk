/**
 * Build Script for bigint-buffer Native Module
 * 
 * Purpose:
 * This script handles the native compilation of the bigint-buffer module, which provides
 * high-performance BigInt <-> Buffer conversions using native C++ code.
 * 
 * Why JavaScript and not TypeScript or an embedded shell script:
 * 1. This is a build script that runs during package installation (postinstall)
 * 2. Using TypeScript would require the TypeScript compiler or ts-node to be available during installation
 * 3. Plain JavaScript ensures this script can run immediately without compilation
 * 4. This script is operating system agnostic, so it can be run on any platform that supports Node.js
 */

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

try {
  // Check if the bigint-buffer module exists in node_modules
  // Using path.join for cross-platform compatibility (Windows/Unix)
  const bigintBufferPath = path.join(process.cwd(), 'node_modules/bigint-buffer');
  
  // Skip if module isn't installed
  if (!existsSync(bigintBufferPath)) {
    console.log('Skipping bigint-buffer build: folder not found');
    process.exit(0);
  }

  // Verify node-gyp (native module build tool) is available
  // node-gyp is required to compile the C++ code in bigint-buffer
  try {
    execSync('command -v node-gyp', { stdio: 'ignore' });
  } catch {
    console.log('Skipping bigint-buffer build: node-gyp not found');
    process.exit(0);
  }

  // Change to the module directory and run the native build
  // node-gyp configure: Creates platform-specific build files
  // node-gyp build: Compiles the native code
  process.chdir(bigintBufferPath);
  execSync('node-gyp configure', { stdio: 'inherit' });
  execSync('node-gyp build', { stdio: 'inherit' });
} catch (error) {
  // Proper error handling for build failures
  console.error('Error building bigint-buffer:', error);
  process.exit(1);
} 