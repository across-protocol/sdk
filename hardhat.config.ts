import { HardhatUserConfig } from "hardhat/config";

// Custom tasks to add to HRE.
// FIXME: Temporarily commenting out tasks to minimize amount of files imported and executed at compile time
// to construct the Hardhat Runtime Environment. Generally we'd prefer to keep the HRE construction
// lightweight and put runnable scripts in the `scripts` directory rather than add as an HRE task.
// TODO: Figure out which imported module in `./tasks` is causing HRE construction to fail.
// require("./tasks");

import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-waffle";
import "@openzeppelin/hardhat-upgrades";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import "solidity-coverage";

const solcVersion = "0.8.18";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: solcVersion, settings: { optimizer: { enabled: true, runs: 1000000 }, viaIR: true } }],
  },

  mocha: {
    timeout: 100000,
  },
};

export default config;
