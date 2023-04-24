const path = require("path");
const hardhatConfig = require("@across-protocol/contracts-v2/dist/hardhat.config");

const coreWkdir = path.dirname(require.resolve("@across-protocol/contracts-v2/package.json"));

const configOverride = {
  paths: {
    root: coreWkdir,
    sources: `${coreWkdir}/contracts`,
    artifacts: `${coreWkdir}/artifacts`,
    cache: `${coreWkdir}/cache`,
  },
};

module.exports = {
  ...hardhatConfig,
  ...configOverride,
};
