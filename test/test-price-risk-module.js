const { expect } = require("chai");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  _E,
  _W,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  addEToken,
  getTransactionEvent,
  accessControlMessage,
  _R,
  grantRole,
} = require("@ensuro/core/js/test-utils");
const { addRiskModuleWithParams } = require("./test-helper");

hre.upgrades.silenceWarnings();

describe("Test PriceRiskModule contract", function () {
  let owner, lp, cust;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await hre.ethers.getSigners();

    _A = amountFunction(6);
  });

  it("Should return the insured asset", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic } = await helpers.loadFixture(
      deployPoolFixture
    );

    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    expect(await rm.asset()).to.equal(wmatic.address);
  });

  it("Should return the reference currency", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic } = await helpers.loadFixture(
      deployPoolFixture
    );

    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    expect(await rm.referenceCurrency()).to.equal(currency.address);
  });

  it("Should never allow reinitialization", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic } = await helpers.loadFixture(
      deployPoolFixture
    );

    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    await expect(
      rm.initialize(
        "Reinitialized rm",
        _W("1"),
        _W("1"),
        _W("0"),
        _A("1000"),
        _A("10000"),
        "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1"
      )
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Should reject if prices not defined", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    await expect(rm.pricePolicy(_A(100), true, _A(1000), 3600)).to.be.revertedWith("Price from not available");

    await priceOracle.setAssetPrice(wmatic.address, _E("0.5"));
    await expect(rm.pricePolicy(_A(100), true, _A(1000), 3600)).to.be.revertedWith("Price to not available");
  });

  it("Should reject if trigger price has already been reached", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    await priceOracle.setAssetPrice(wmatic.address, _E("0.0005")); // 1 ETH = 2000 WMATIC
    await priceOracle.setAssetPrice(currency.address, _E("0.000333333")); // 1 ETH = 3000 USDC
    // Therefore 1 WMATIC = 1.5 USDC
    await expect(rm.pricePolicy(_A(2), true, _A(1000), 3600)).to.be.revertedWith("Price already at trigger value");

    await expect(rm.pricePolicy(_A(1), false, _A(1000), 3600)).to.be.revertedWith("Price already at trigger value");
  });

  it("Should only allow PRICER to set CDFs", async () => {
    const { currency, wmatic, priceOracle, PriceRiskModule, pool, premiumsAccount, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

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

  it("Should calculate exchange rate between different assets (Wad vs 6 decimals)", async () => {
    const { currency, wmatic, priceOracle, PriceRiskModule, pool, premiumsAccount } = await helpers.loadFixture(
      deployPoolFixture
    );
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });

    await priceOracle.setAssetPrice(wmatic.address, _E("0.2"));
    await priceOracle.setAssetPrice(currency.address, _E("0.5"));

    expect(await rm._getExchangeRate(wmatic.address, currency.address)).to.equal(_A(0.4));

    expect(await rm._getExchangeRate(currency.address, wmatic.address)).to.equal(_W("2.5"));
  });

  it("Should calculate exchange rate between different assets (Ray vs 9 decimals)", async () => {
    const { priceOracle, PriceRiskModule, pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const _A27 = _R;
    const asset27d = await initCurrency({
      name: "27 decimals",
      symbol: "27D",
      decimals: 27,
      initial_supply: _A27("100"),
    });

    const _A9 = amountFunction(9);
    const asset9d = await initCurrency({
      name: "9 decimals",
      symbol: "9D",
      decimals: 9,
      initial_supply: _A9("100"),
    });

    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [asset27d.address, asset9d.address, priceOracle.address, _W("0.01")],
    });

    await priceOracle.setAssetPrice(asset27d.address, _E("0.001"));
    await priceOracle.setAssetPrice(asset9d.address, _E("0.08"));

    expect(await rm._getExchangeRate(asset27d.address, asset9d.address)).to.equal(_A9(0.0125));
    expect(await rm._getExchangeRate(asset9d.address, asset27d.address)).to.equal(_A27(80));
  });

  it("Should calculate policy premium and loss probability (1% slots)", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
    });
    const start = (await owner.provider.getBlock("latest")).timestamp;

    await priceOracle.setAssetPrice(wmatic.address, _E("0.0005")); // 1 ETH = 2000 WMATIC
    await priceOracle.setAssetPrice(currency.address, _E("0.000333333")); // 1 ETH = 3000 USDC

    // => 1 WMATIC = 1.5 USDC

    const [price0, lossProb0] = await rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = _W(i / 100);
    cdf[priceSlots - 1] = _W("0.5");
    await rm.connect(owner).setCDF(1, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A(1.494), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, lossProb] = await rm.pricePolicy(_A(1.3155), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, lossProb] = await rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600);
    // expect(price0).to.equal(0);
    expect(lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_A(0.8), true, _A(1000), start + 3600);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600));
  });

  it("Should calculate policy premium and loss probability (13% slots)", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.13")],
    });

    await priceOracle.setAssetPrice(wmatic.address, _E("1.481481")); // 1 ETH = 0.675 WMATIC
    await priceOracle.setAssetPrice(currency.address, _E("0.000740")); // 1 ETH = 1350 USDC

    // => 1 WMATIC = 2000 USDC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[0] = _W("0.5");
    cdf[2] = _W("0.7");
    cdf[8] = _W("0.001");
    await rm.connect(owner).setCDF(2, cdf);

    const start = (await owner.provider.getBlock("latest")).timestamp;
    const expiration = start + 3600 * 2;

    // With a variation of 0.4% ($2000 -> $1992) we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A(1992), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));

    // With a variation of 30% we have the probability of the 2nd slot
    [premium, lossProb] = await rm.pricePolicy(_A(1400), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.7"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));

    // With a variation of 100% we have the probability of the 8th slot
    [premium, lossProb] = await rm.pricePolicy(_A(0), true, _A(1000), expiration);
    expect(lossProb).to.equal(_W("0.001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), lossProb, expiration));
  });

  it("Should calculate policy premium and loss probability (5% slots, shorted asset)", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.05")],
    });

    await priceOracle.setAssetPrice(wmatic.address, _E("1.481481")); // 1 ETH = 0.675 WMATIC
    await priceOracle.setAssetPrice(currency.address, _E("0.0005")); // 1 ETH = 2000 USDC

    // => 1 WMATIC = 2963.682 USDC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[0] = _W("0.5");
    cdf[5] = _W("0.03");
    cdf[20] = _W("0.0001");
    cdf[priceSlots - 1] = _W("0.000005");
    await rm.connect(owner).setCDF(-3, cdf);

    const start = (await owner.provider.getBlock("latest")).timestamp;
    const expiration = start + 3600 * 3;

    // With a variation of 0.000444% we have the probability of the first slot
    let [premium, lossProb] = await rm.pricePolicy(_A(2965), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 27% we have the probability of the 5th slot
    [premium, lossProb] = await rm.pricePolicy(_A(3763), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.03"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 100% we have the probability of the 20th slot
    [premium, lossProb] = await rm.pricePolicy(_A(5928), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.0001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));

    // With a variation of 150% we have the probability of the last slot
    [premium, lossProb] = await rm.pricePolicy(_A(7410), false, _A(2000), expiration);
    expect(lossProb).to.equal(_W("0.000005"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), lossProb, expiration));
  });

  it("Should trigger the policy only if threshold met", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
      scrPercentage: "0.5",
    });
    grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const start = (await owner.provider.getBlock("latest")).timestamp;

    await priceOracle.setAssetPrice(currency.address, _E("0.0004")); // 1 ETH = 2500 USDC
    await priceOracle.setAssetPrice(wmatic.address, _E("0.00056")); // 1 ETH = 1785.71... WMATIC
    // 1 WMATIC = 1.4 USDC

    // Set price
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[20] = _W("0.03");
    cdf[21] = _W("0.05");
    cdf[priceSlots - 1] = _W("0.1");
    await rm.connect(owner).setCDF(1, cdf);

    await expect(rm.connect(cust).newPolicy(_A(1.2), true, _A(1000), start + 3600)).to.be.revertedWith(
      "Either duration or percentage jump not supported"
    );

    const [premium, lossProb] = await rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_W("0.05"));
    await currency.connect(cust).approve(pool.address, premium);
    let tx = await rm.connect(cust).newPolicy(_A(1.1), true, _A(1000), start + 3600);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");
    expect(newPolicyEvt.args.policy.id).to.equal(rm.address + "000000000000000000000001");
    const policyId = newPolicyEvt.args.policy.id;
    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.05"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.05));

    expect(newPricePolicyEvt.args.lower).to.be.equal(true);
    expect(newPricePolicyEvt.args.policyId).to.be.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.be.equal(_A(1.1));

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice > triggerPrice");

    // Change price of WMATIC to 1.1
    await priceOracle.setAssetPrice(wmatic.address, _E("0.00044")); // 1 ETH = 2272.7... WMATIC
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should trigger the policy only if threshold met - Shorted asset", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
      scrPercentage: "0.5",
    });
    grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const start = (await owner.provider.getBlock("latest")).timestamp;

    await priceOracle.setAssetPrice(currency.address, _E("0.0004")); // 1 ETH = 2500 USDC
    await priceOracle.setAssetPrice(wmatic.address, _E("0.00056")); // 1 ETH = 1785.71... WMATIC
    // 1 WMATIC = 1.4 USDC

    // Set price
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    cdf[20] = _W("0.02");
    cdf[21] = _W("0.04");
    cdf[priceSlots - 1] = _W("0.1");
    await rm.connect(owner).setCDF(-1, cdf);

    const [premium, lossProb] = await rm.pricePolicy(_A(1.7), false, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_W("0.04"));
    await currency.connect(cust).approve(pool.address, premium);

    let tx = await rm.connect(cust).newPolicy(_A(1.7), false, _A(1000), start + 3600);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");
    expect(newPolicyEvt.args.policy.id).to.equal(rm.address + "000000000000000000000001");
    const policyId = newPolicyEvt.args.policy.id;
    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.04"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.04));

    expect(newPricePolicyEvt.args.lower).to.be.equal(false);
    expect(newPricePolicyEvt.args.policyId).to.be.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.be.equal(_A(1.7));

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice < triggerPrice");

    // Change price of WMATIC to 1.75
    await priceOracle.setAssetPrice(wmatic.address, _E("0.0007"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should not allow operations when paused", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
      scrPercentage: "0.5",
    });

    await expect(rm.pause()).to.be.revertedWith(accessControlMessage(owner.address, rm.address, "GUARDIAN_ROLE"));
    expect(await rm.paused()).to.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner.address);
    await rm.pause();
    expect(await rm.paused()).to.equal(true);

    await priceOracle.setAssetPrice(currency.address, _E("0.0004")); // 1 ETH = 2500 USDC
    await priceOracle.setAssetPrice(wmatic.address, _E("0.00056")); // 1 ETH = 1785.71... WMATIC

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);
    const priceSlots = await rm.PRICE_SLOTS();
    const cdf = _makeArray(priceSlots, 0);
    await expect(rm.setCDF(1, cdf)).to.be.revertedWith("Pausable: paused");

    await expect(rm.triggerPolicy(1)).to.be.revertedWith("Pausable: paused");
  });

  it("PriceRiskModule asset address validation", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);

    const zeroAddress = "0x0000000000000000000000000000000000000000";
    let rm = await expect(
      addRiskModuleWithParams(pool, undefined, premiumsAccount, undefined, PriceRiskModule, {
        extraConstructorArgs: [zeroAddress, currency.address, priceOracle.address, _W("0.01")],
        scrPercentage: "0.5",
      })
    ).to.be.revertedWith("PriceRiskModule: asset cannot be the zero address");

    rm = await addRiskModuleWithParams(pool, undefined, premiumsAccount, undefined, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
      scrPercentage: "0.5",
    });

    expect(await rm.name()).to.equal("RiskModule");
    expect(await rm.asset()).to.equal(wmatic.address);
  });

  it("PriceRiskModule currency address validation", async () => {
    const { pool, currency, priceOracle, PriceRiskModule, premiumsAccount, wmatic, accessManager } =
      await helpers.loadFixture(deployPoolFixture);

    const zeroAddress = "0x0000000000000000000000000000000000000000";
    let rm = await expect(
      addRiskModuleWithParams(pool, undefined, premiumsAccount, undefined, PriceRiskModule, {
        extraConstructorArgs: [wmatic.address, zeroAddress, priceOracle.address, _W("0.01")],
        scrPercentage: "0.5",
      })
    ).to.be.revertedWith("PriceRiskModule: referenceCurrency cannot be the zero address");

    rm = await addRiskModuleWithParams(pool, undefined, premiumsAccount, undefined, PriceRiskModule, {
      extraConstructorArgs: [wmatic.address, currency.address, priceOracle.address, _W("0.01")],
      scrPercentage: "0.5",
    });

    expect(await rm.name()).to.equal("RiskModule");
    expect(await rm.referenceCurrency()).to.equal(currency.address);
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(10000) },
      [lp, cust],
      [_A(5000), _A(500)]
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

    const PriceOracle = await hre.ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy();
    const accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    const PriceRiskModule = await hre.ethers.getContractFactory("PriceRiskModule");

    await currency.connect(lp).approve(pool.address, _A(5000));
    await pool.connect(lp).deposit(etk.address, _A(5000));
    return {
      PriceRiskModule,
      pool,
      currency,
      accessManager,
      etk,
      priceOracle,
      premiumsAccount,
      wmatic,
    };
  }
});

function _makeArray(n, initialValue) {
  const ret = new Array(n);
  for (let i = 0; i < n; i++) {
    ret[i] = initialValue;
  }
  return ret;
}
