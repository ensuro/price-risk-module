const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { _E, _W, amountFunction } = require("@ensuro/core/js/utils");
const { forkIt } = require("./utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test PriceRiskModule contract", function () {
  const _A = amountFunction(6);
  const _A8 = amountFunction(8);
  const _A20 = amountFunction(20);
  let ChainlinkPriceOracle;

  beforeEach(async () => {
    ChainlinkPriceOracle = await ethers.getContractFactory("ChainlinkPriceOracle");
  });

  async function addRound(oracle, price, startedAt, updatedAt, answeredInRound) {
    const now = await helpers.time.latest();
    return oracle._addRound(price, startedAt || now, updatedAt || now, answeredInRound || 0);
  }

  async function deployAggMock(decimals = 8) {
    const AggregatorV3Mock = await ethers.getContractFactory("AggregatorV3Mock");
    const aggContract = AggregatorV3Mock.deploy(decimals);
    return aggContract;
  }

  it("Should construct the ChainlinkPriceOracle", async () => {
    const reference = await deployAggMock(8);
    const asset = await deployAggMock(8);
    const oracle = await ChainlinkPriceOracle.deploy(asset.target, reference.target, 3600);
    expect(await oracle.assetOracle()).to.be.equal(asset.target);
    expect(await oracle.referenceOracle()).to.be.equal(reference.target);
    expect(await oracle.oracleTolerance()).to.be.equal(3600);
  });

  it("Should revert if assetOracle=0 but accept referenceOracle=0", async () => {
    const asset = await deployAggMock(8);
    await expect(ChainlinkPriceOracle.deploy(ZeroAddress, ZeroAddress, 3600)).to.be.revertedWith(
      "PriceRiskModule: assetOracle_ cannot be the zero address"
    );

    const oracle = await ChainlinkPriceOracle.deploy(asset.target, ZeroAddress, 3600);
    expect(await oracle.assetOracle()).to.be.equal(asset.target);
    expect(await oracle.referenceOracle()).to.be.equal(ZeroAddress);
    expect(await oracle.oracleTolerance()).to.be.equal(3600);
  });

  it("getCurrentPrice should revert if prices are zero or old", async () => {
    const now = await helpers.time.latest();
    const reference = await deployAggMock(8);
    const asset = await deployAggMock(8);
    const oracle = await ChainlinkPriceOracle.deploy(asset.target, reference.target, 3600);

    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price is older than tolerable");

    await addRound(asset, 0);
    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price from not available");
    await addRound(asset, _A8("1.5"), now - 3800, now - 3800);
    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price is older than tolerable");
    await addRound(asset, _A8("2.5"), now, now);

    // Keeps failing because of referenceOracle missing price
    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price is older than tolerable");
    await addRound(reference, 0);
    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price to not available");
    await addRound(reference, _A8("0.1"), now - 3800, now - 3800);
    await expect(oracle.getCurrentPrice()).to.be.revertedWith("Price is older than tolerable");
    await addRound(reference, _A8("0.5"), now, now);

    expect(await oracle.getCurrentPrice()).to.be.equal(_W("5"));
  });

  it("If not reference, returns just the asset price", async () => {
    const asset = await deployAggMock(8);
    const oracle = await ChainlinkPriceOracle.deploy(asset.target, ZeroAddress, 3600);

    await addRound(asset, _A8("34.2"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W("34.2"));
  });

  it("It works fine with different decimal combinations", async () => {
    // Asset = 6 decimals / Reference = 8 decimals
    let asset = await deployAggMock(6);
    let reference = await deployAggMock(8);
    let oracle = await ChainlinkPriceOracle.deploy(asset.target, reference.target, 3600);

    await addRound(asset, _A("10"));
    await addRound(reference, _A8("2"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W("5"));
    await addRound(reference, _A8("20"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W(".5"));

    // Asset = 8 decimals / Reference = 6 decimals
    asset = await deployAggMock(8);
    reference = await deployAggMock(6);
    oracle = await ChainlinkPriceOracle.deploy(asset.target, reference.target, 3600);
    await addRound(asset, _A8("10"));
    await addRound(reference, _A("2"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W("5"));

    // Asset = 18 decimals / Reference = 20 decimals
    asset = await deployAggMock(18);
    reference = await deployAggMock(20);
    oracle = await ChainlinkPriceOracle.deploy(asset.target, reference.target, 3600);
    await addRound(asset, _W("8"));
    await addRound(reference, _A20("2"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W("4"));

    // Asset = 20 decimals / Reference = null
    asset = await deployAggMock(20);
    reference = await deployAggMock(20);
    oracle = await ChainlinkPriceOracle.deploy(asset.target, ZeroAddress, 3600);
    await addRound(asset, _A20("8"));
    expect(await oracle.getCurrentPrice()).to.be.equal(_W("8"));
  });

  forkIt("Should work with real chainlink oracles (forking at https://polygonscan.com/block/34906609)", async () => {
    if (process.env.ALCHEMY_URL === undefined) throw new Error("Define envvar ALCHEMY_URL for this test");
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 34906609, // polygon mainnet
          },
        },
      ],
    });

    const _U = amountFunction(8);

    const BNB_ORACLE_ADDRESS = "0x82a6c4AF830caa6c97bb504425f6A66165C2c26e";
    const USDC_ORACLE_ADDRESS = "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7";

    const assetOracle = await ethers.getContractAt("AggregatorV3Interface", BNB_ORACLE_ADDRESS);
    const referenceOracle = await ethers.getContractAt("AggregatorV3Interface", USDC_ORACLE_ADDRESS);

    // Sanity check: are we in the right chain with the right block?
    const [, assetPrice] = await assetOracle.latestRoundData();
    expect(assetPrice).to.equal(_U("293.18"));
    const [, referencePrice] = await referenceOracle.latestRoundData();
    expect(referencePrice).to.equal(_U("1.00002339"));

    // Contract setup
    const oracle = await ChainlinkPriceOracle.deploy(assetOracle.target, referenceOracle.target, HOUR);
    expect(await oracle.getCurrentPrice()).to.closeTo(_E("293.17314268"), _E("0.00000001"));

    const inverseOracle = await ChainlinkPriceOracle.deploy(referenceOracle.target, assetOracle.target, HOUR);

    expect(await inverseOracle.getCurrentPrice()).to.closeTo(_E("0.00341095"), _E("0.00000001"));
  });
});
