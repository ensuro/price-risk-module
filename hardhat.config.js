require("dotenv").config();

require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("hardhat-gas-reporter");
require("solidity-coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.16",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  networks: {
    hardhat: {
      chains: {
        137: {
          hardforkHistory: {
            london: 54659737,
          },
        },
      },
    },
  },
  dependencyCompiler: {
    paths: [
      "@ensuro/core/contracts/PolicyPool.sol",
      "@ensuro/core/contracts/AccessManager.sol",
      "@ensuro/core/contracts/PremiumsAccount.sol",
      "@ensuro/core/contracts/EToken.sol",
      "@ensuro/core/contracts/mocks/TestCurrency.sol",
    ],
  },
  gasReporter: {
    currency: "USD",
    coinmarketcap: "1b0c87b0-c123-48d1-86f9-1544ef487220",
    enabled: process.env.REPORT_GAS !== undefined,
  },
};
