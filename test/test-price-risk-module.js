const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const ethers = require("ethers");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _E,
  _W,
  addRiskModule,
  grantComponentRole,
  addEToken,
  getTransactionEvent,
  accessControlMessage,
  _R,
  grantRole,
  blockchainNow,
  _BN,
} = require("@ensuro/core/js/test-utils");

hre.upgrades.silenceWarnings();

function amountFunction(decimals) {
  // TODO: move this upstream to ensuro utils
  return function (value) {
    if (value === undefined) return undefined;
    if (typeof value === "string" || value instanceof String) {
      return ethers.utils.parseUnits(value, decimals);
    } else {
      return _BN(Math.round(value * 1e6)).mul(_BN(10).pow(decimals - 6));
    }
  };
}

describe("Test PriceRiskModule contract", function () {
  let owner, lp, cust;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await hre.ethers.getSigners();

    const decimals = 6;
    _A = amountFunction(6);
  });

  it("Should return the asset oracle", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    expect(await rm.assetOracle()).to.equal(assetOracle.address);
  });

  it("Should return the reference oracle", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    expect(await rm.referenceOracle()).to.equal(referenceOracle.address);
  });

  it("Should return the oracle tolerance", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    expect(await rm.oracleTolerance()).to.equal(3600);
  });

  it("Should never allow reinitialization", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await expect(
      rm.initialize(
        "Reinitialized rm",
        _W("1"),
        _W("1"),
        _W("0"),
        _A("1000"),
        _A("10000"),
        "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1",
        3600
      )
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Should only allow PRICER to set the oracleTolerance", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    expect(await rm.oracleTolerance()).to.equal(3600);

    await expect(rm.setOracleTolerance(1800)).to.be.revertedWith(
      accessControlMessage(owner.address, rm.address, "PRICER_ROLE")
    );
    expect(await rm.oracleTolerance()).to.equal(3600);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    await expect(rm.setOracleTolerance(1800)).not.to.be.reverted;

    expect(await rm.oracleTolerance()).to.equal(1800);
  });

  it("Should only allow PRICER to set CDFs", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    const newCdf = _makeArray(await rm.PRICE_SLOTS(), 0);
    newCdf[0] = _W("0.2");
    newCdf[newCdf.length - 1] = _W("0.5");

    expect((await rm.getCDF(1))[0]).to.equal(_W(0));
    expect((await rm.getCDF(1))[newCdf.length - 1]).to.equal(_W(0));

    await expect(rm.setCDF(1, newCdf)).to.be.revertedWith(
      accessControlMessage(owner.address, rm.address, "PRICER_ROLE")
    );

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);
    await expect(rm.connect(owner).setCDF(1, newCdf)).not.to.be.reverted;

    expect((await rm.getCDF(1))[0]).to.equal(_W("0.2"));
    expect((await rm.getCDF(1))[newCdf.length - 1]).to.equal(_W("0.5"));
  });

  it("Should not allow setting prices for policies with no duration", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    const newCdf = _makeArray(await rm.PRICE_SLOTS(), 0);
    newCdf[0] = _W("0.2");
    newCdf[newCdf.length - 1] = _W("0.5");

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    await expect(rm.connect(owner).setCDF(0, newCdf)).to.be.revertedWith("|duration| < 1");
  });

  it("Should not allow new policies if prices are not defined", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    // Last round for the asset has no price
    await addRound(assetOracle, _E("0"));
    await expect(rm.pricePolicy(_E("100"), true, _A(1000), 3600)).to.be.revertedWith("Price from not available");

    // Last round for the asset has a price but the reference doesn't
    await addRound(assetOracle, _E("1"));
    await addRound(referenceOracle, _E("0"));
    await expect(rm.pricePolicy(_E("100"), true, _A(1000), 3600)).to.be.revertedWith("Price to not available");
  });

  it("Should not allow new policies if prices are not fresh", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    const now = await blockchainNow(owner);

    // The price for the asset is twice as old as tolerance
    const tolerance = await rm.oracleTolerance();
    await addRound(assetOracle, _E("100"), now - tolerance * 2, now - tolerance * 2);

    // The price for the reference is current
    await addRound(referenceOracle, _E("130"));

    await expect(rm.pricePolicy(_E("2"), true, _A(1000), 3600)).to.be.revertedWith("Price is older than tolerable");

    // The asset price is now current
    await addRound(assetOracle, _E("100"));

    // The reference price is old
    await addRound(referenceOracle, _E("130"), now - tolerance, now - tolerance);

    await expect(rm.pricePolicy(_E("2"), true, _A(1000), 3600)).to.be.revertedWith("Price is older than tolerable");
  });

  it("Should reject if trigger price has already been reached", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await addRound(assetOracle, _E("0.0005")); // 1 ETH = 2000 WMATIC
    await addRound(referenceOracle, _E("0.000333333")); // 1 ETH = 3000 USDC
    // Therefore 1 WMATIC = 1.5 USDC

    await expect(rm.pricePolicy(_E("2"), true, _A(1000), 3600)).to.be.revertedWith("Price already at trigger value");

    await expect(rm.pricePolicy(_E("1"), false, _A(1000), 3600)).to.be.revertedWith("Price already at trigger value");
  });

  it("Should calculate exchange rate between different assets (Wad vs 6 decimals)", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 6);

    await addRound(assetOracle, _E("0.2"));
    await addRound(referenceOracle, _A(0.5));

    expect(await rm._getExchangeRate(assetOracle.address, referenceOracle.address)).to.equal(_W("0.4"));

    expect(await rm._getExchangeRate(referenceOracle.address, assetOracle.address)).to.equal(_W("2.5"));
  });

  it("Should calculate exchange rate between different assets (Ray vs 9 decimals)", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 27, 9);

    const _A27 = _R;
    const _A9 = amountFunction(9);

    await addRound(assetOracle, _A27("0.001"));
    await addRound(referenceOracle, _A9(0.08));

    expect(await rm._getExchangeRate(assetOracle.address, referenceOracle.address)).to.equal(_W("0.0125"));
    expect(await rm._getExchangeRate(referenceOracle.address, assetOracle.address)).to.equal(_W("80"));
  });

  it("Should calculate policy premium and loss probability (1% slots)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await addRound(assetOracle, _E("0.0005")); // 1 ETH = 2000 WMATIC
    await addRound(referenceOracle, _E("0.000333333")); // 1 ETH = 3000 USDC
    // Therefore 1 WMATIC = 1.5 USDC

    const start = await blockchainNow(owner);

    const [price0, lossProb0] = await rm.pricePolicy(_E("1.1"), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = _W(i / 100);
    cdf[priceSlots - 1] = _W("0.5");
    await rm.connect(owner).setCDF(1, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_E("1.494"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, lossProb] = await rm.pricePolicy(_E("1.3155"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, lossProb] = await rm.pricePolicy(_E("1.1"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_E("0.8"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));
  });

  it("Should calculate policy premium and loss probability (13% slots)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(
      pool,
      premiumsAccount,
      18,
      18,
      null,
      _W("0.13")
    );

    await addRound(assetOracle, _E("1.481481")); // 1 ETH = 0.675 WMATIC
    await addRound(referenceOracle, _E("0.000740")); // 1 ETH = 1350 USDC
    // Therefore 1 WMATIC = 2000 USDC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[0] = _W("0.5");
    cdf[2] = _W("0.7");
    cdf[8] = _W("0.001");
    await rm.connect(owner).setCDF(2, cdf);

    const start = await blockchainNow(owner);
    const expiration = start + 3600 * 2;

    // With a variation of 0.4% ($2000 -> $1992) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_E("1992"), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));

    // With a variation of 30% we have the probability of the 2nd slot
    [premium, lossProb] = await rm.pricePolicy(_E("1400"), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.7"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));

    // With a variation of 100% we have the probability of the 8th slot
    [premium, lossProb] = await rm.pricePolicy(_E("0"), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));
  });

  it("Should calculate policy premium and loss probability (5% slots, shorted asset)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(
      pool,
      premiumsAccount,
      18,
      18,
      null,
      _W("0.05")
    );

    await addRound(assetOracle, _E("1.481481")); // 1 ETH = 0.675 WMATIC
    await addRound(referenceOracle, _E("0.0005")); // 1 ETH = 2000 USDC
    // Therefore 1 WMATIC = 2963.682 USDC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[0] = _W("0.5");
    cdf[5] = _W("0.03");
    cdf[20] = _W("0.0001");
    cdf[priceSlots - 1] = _W("0.000005");
    await rm.connect(owner).setCDF(-3, cdf);

    const start = await blockchainNow(owner);
    const expiration = start + 3600 * 3;

    // With a variation of 0.000444% we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_E("2965"), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 27% we have the probability of the 5th slot
    [premium, lossProb] = await rm.pricePolicy(_E("3763"), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.03"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 100% we have the probability of the 20th slot
    [premium, lossProb] = await rm.pricePolicy(_E("5928"), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.0001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 150% we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_E("7410"), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.000005"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));
  });

  it("Should calculate policy premium and loss probability (1% slots, Wad vs 6 decimals)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 6);

    await addRound(assetOracle, _E("0.0005")); // 1 USD = 2000 WMATIC
    await addRound(referenceOracle, _A("0.000333")); // 1 USD = 3000 RTK
    // Therefore 1 WMATIC = 1.5 RTK

    const start = await blockchainNow(owner);

    const [price0, lossProb0] = await rm.pricePolicy(_A("1.1"), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = _W(i / 100);
    cdf[priceSlots - 1] = _W("0.5");
    await rm.connect(owner).setCDF(1, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A("1.494"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, lossProb] = await rm.pricePolicy(_A("1.3155"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, lossProb] = await rm.pricePolicy(_A("1.1"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_A("0.8"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));
  });

  it("Should calculate policy premium and loss probability (1% slots, Ray vs 9 decimals)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 27, 9);

    const _A27 = _R;
    const _A9 = amountFunction(9);

    await addRound(assetOracle, _A27("0.0005")); // 1 Ray = 2000 WMATIC
    await addRound(referenceOracle, _A9("0.000333")); // 1 Ray = 3000 RTK
    // Therefore 1 WMATIC = 1.5 RTK

    const start = await blockchainNow(owner);

    const [price0, lossProb0] = await rm.pricePolicy(_A9("1.1"), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = _W(i / 100);
    cdf[priceSlots - 1] = _W("0.5");
    await rm.connect(owner).setCDF(1, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A9("1.494"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, lossProb] = await rm.pricePolicy(_A9("1.3155"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, lossProb] = await rm.pricePolicy(_A9("1.1"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_A9("0.8"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));
  });

  it("Should calculate policy premium and loss probability (1% slots, Ray vs 6 decimals)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 27, 6);

    const _A27 = _R;

    await addRound(assetOracle, _A27("0.0005")); // 1 Ray = 2000 WMATIC
    await addRound(referenceOracle, _A("0.000333")); // 1 Ray = 3000 RTK
    // Therefore 1 WMATIC = 1.5 RTK

    const start = await blockchainNow(owner);

    const [price0, lossProb0] = await rm.pricePolicy(_A("1.1"), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = _W(i / 100);
    cdf[priceSlots - 1] = _W("0.5");
    await rm.connect(owner).setCDF(1, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A("1.494"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, lossProb] = await rm.pricePolicy(_A("1.3155"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, lossProb] = await rm.pricePolicy(_A("1.1"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_A("0.8"), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));
  });

  it("Should trigger the policy only if threshold met", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await addRound(assetOracle, _E("0.00056")); // 1 ETH = 1785.71... WMATIC
    await addRound(referenceOracle, _E("0.0004")); // 1 ETH = 2500 USDC
    // Therefore 1 WMATIC = 1.4 USDC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    // Set price
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[20] = _W("0.03");
    cdf[21] = _W("0.05");
    cdf[priceSlots - 1] = _W("0.1");
    await rm.connect(owner).setCDF(1, cdf);

    const start = await blockchainNow(owner);

    await expect(rm.connect(cust).newPolicy(_E("1.2"), true, _A(1000), start + 3600)).to.be.revertedWith(
      "Either duration or percentage jump not supported"
    );

    const [premium, lossProb] = await rm.pricePolicy(_E("1.1"), true, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_W("0.05"));

    await currency.connect(cust).approve(pool.address, premium);

    let tx = await rm.connect(cust).newPolicy(_E("1.1"), true, _A(1000), start + 3600);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");

    const policyId = newPolicyEvt.args.policy.id;
    expect(policyId).to.equal(rm.address + "000000000000000000000001");

    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.05"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.05));

    expect(newPricePolicyEvt.args.lower).to.equal(true);
    expect(newPricePolicyEvt.args.policyId).to.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.equal(_W("1.1"));

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice > triggerPrice");

    // Change price of asset to 1.1
    await addRound(assetOracle, _E("0.00044")); // 1 ETH = 2272.7... WMATIC
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should trigger the policy only if threshold met - Shorted asset", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);

    const { rm, assetOracle, referenceOracle } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await addRound(assetOracle, _E("0.00056")); // 1 ETH = 1785.71... WMATIC
    await addRound(referenceOracle, _E("0.0004")); // 1 ETH = 2500 USDC
    // Therefore 1 WMATIC = 1.4 USDC

    // Set price
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[20] = _W("0.02");
    cdf[21] = _W("0.04");
    cdf[priceSlots - 1] = _W("0.1");
    await rm.connect(owner).setCDF(-1, cdf);

    const start = await blockchainNow(owner);

    const [premium, lossProb] = await rm.pricePolicy(_E("1.7"), false, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_W("0.04"));
    await currency.connect(cust).approve(pool.address, premium);

    let tx = await rm.connect(cust).newPolicy(_E("1.7"), false, _A(1000), start + 3600);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");
    const policyId = newPolicyEvt.args.policy.id;
    expect(policyId).to.equal(rm.address + "000000000000000000000001");
    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.04"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.04));

    expect(newPricePolicyEvt.args.lower).to.equal(false);
    expect(newPricePolicyEvt.args.policyId).to.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.equal(_W("1.7"));

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice < triggerPrice");

    // Change price of WMATIC to 1.75
    await addRound(assetOracle, _E("0.0007"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should not allow operations when paused", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount, 18, 18);

    await expect(rm.pause()).to.be.revertedWith(accessControlMessage(owner.address, rm.address, "GUARDIAN_ROLE"));
    expect(await rm.paused()).to.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await rm.pause();
    expect(await rm.paused()).to.equal(true);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    await expect(rm.setCDF(1, cdf)).to.be.revertedWith("Pausable: paused");

    await expect(rm.newPolicy(_E("1.1"), true, _A(1000), (await blockchainNow(owner)) + 3600)).to.be.revertedWith(
      "Pausable: paused"
    );
    await expect(rm.triggerPolicy(1)).to.be.revertedWith("Pausable: paused");

    await expect(rm.setOracleTolerance(1800)).to.be.revertedWith("Pausable: paused");
  });

  it("Should behave as expected when using the actual chainlink contracts (fork test)", async () => {});

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A("10000") },
      [lp, cust],
      [_A("5000"), _A("500")]
    );

    const wmatic = await initCurrency({ name: "Test WETH", symbol: "WETH", decimals: 18, initial_supply: _E("1000") });

    const pool = await deployPool(hre, {
      currency: currency.address,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const etk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(hre, pool, { srEtkAddr: etk.address });

    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    await currency.connect(lp).approve(pool.address, _A("5000"));
    await pool.connect(lp).deposit(etk.address, _A("5000"));
    return {
      pool,
      currency,
      accessManager,
      etk,
      premiumsAccount,
      wmatic,
    };
  }

  async function addRound(oracle, price, startedAt, updatedAt, answeredInRound) {
    const now = await blockchainNow(owner);
    return oracle._addRound(price, startedAt || now, updatedAt || now, answeredInRound || 0);
  }
});

async function addRiskModuleWithOracles(
  pool,
  premiumsAccount,
  assetDecimals,
  referenceDecimals,
  oracleTolerance,
  slotSize
) {
  const PriceOracle = await hre.ethers.getContractFactory("AggregatorV3Mock");
  const PriceRiskModule = await hre.ethers.getContractFactory("PriceRiskModule");

  const assetOracle = await PriceOracle.deploy(assetDecimals);
  assetOracle._P = amountFunction(assetDecimals);

  const referenceOracle = await PriceOracle.deploy(referenceDecimals);
  referenceOracle._P = amountFunction(referenceDecimals);

  const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
    extraConstructorArgs: [assetOracle.address, referenceOracle.address, slotSize || _W("0.01")],
    extraArgs: [oracleTolerance || 3600],
  });

  return { PriceOracle, PriceRiskModule, assetOracle, referenceOracle, rm };
}

function _makeArray(n, initialValue) {
  const ret = new Array(n);
  for (let i = 0; i < n; i++) {
    ret[i] = initialValue;
  }
  return ret;
}
