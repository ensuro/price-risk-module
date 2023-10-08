const hre = require("hardhat");

const skipForkTests = process.env.SKIP_FORK_TESTS === "true";
const forkIt = skipForkTests ? it.skip : it;

async function fork(blockNumber) {
  if (process.env.ALCHEMY_URL === undefined) throw new Error("Define envvar ALCHEMY_URL for this test");
  return hre.network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl: process.env.ALCHEMY_URL,
          blockNumber: blockNumber,
        },
      },
    ],
  });
}

module.exports = {
  fork,
  forkIt,
  skipForkTests,
};
