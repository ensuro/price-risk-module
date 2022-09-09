require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("solidity-coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.6",
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
  dependencyCompiler: {
    paths: [
      "@ensuro/core/contracts/PolicyPool.sol",
      "@ensuro/core/contracts/AccessManager.sol",
      "@ensuro/core/contracts/PremiumsAccount.sol",
      "@ensuro/core/contracts/PolicyNFT.sol",
      "@ensuro/core/contracts/EToken.sol",
      "@ensuro/core/contracts/mocks/TestCurrency.sol",
    ],
  },
};
