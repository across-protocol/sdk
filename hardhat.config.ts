import "hardhat-watcher";
import "@nomiclabs/hardhat-etherscan";
import "@nomicfoundation/hardhat-chai-matchers";
import "@openzeppelin/hardhat-upgrades";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import { HardhatUserConfig } from "hardhat/config";
import "solidity-coverage";

const solcVersion = "0.8.23";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: solcVersion, settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } }],
  },
  networks: {
    hardhat: { accounts: { accountsBalance: "1000000000000000000000000" } },
  },
  mocha: {
    timeout: 100000,
    require: ["./test/Solana.setup.ts"],
  },
  watcher: {
    test: {
      tasks: [{ command: "test" }],
      files: ["./test/**/*", "./src/**/*", "./contracts/**/*"],
      verbose: true,
    },
  },
};

export default config;
