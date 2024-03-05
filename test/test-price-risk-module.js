const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  _W,
  _E,
  amountFunction,
  getTransactionEvent,
  accessControlMessage,
  grantRole,
  grantComponentRole,
  makePolicyId,
} = require("@ensuro/core/js/utils");
const {
  initCurrency,
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
} = require("@ensuro/core/js/test-utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test PriceRiskModule contract", function () {
  let cust, lp, owner;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

    const decimals = 6;
    _A = amountFunction(decimals);
  });

  it("Should return the asset oracle", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    expect(await rm.oracle()).to.equal(oracle);
  });

  it("Should return the minDuration", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    expect(await rm.minDuration()).to.equal(HOUR);
  });

  it("Should revert if oracle = address(0)", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const oracle = ZeroAddress;
    await expect(addPriceRiskModule(pool, premiumsAccount, oracle)).to.be.revertedWith(
      "PriceRiskModule: oracle_ cannot be the zero address"
    );
  });

  it("Should never allow reinitialization", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await expect(
      rm.initialize(
        "Reinitialized rm",
        _W("1"),
        _W("1"),
        _W("0"),
        _A("1000"),
        _A("10000"),
        "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1",
        oracle
      )
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Should only allow ORACLE_ADMIN to change the oracle", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    expect(await rm.oracle()).to.equal(oracle);

    const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
    const newOracle = await PriceOracleMock.deploy(_W(2));

    await expect(rm.setOracle(newOracle)).to.be.revertedWith(accessControlMessage(owner, rm, "ORACLE_ADMIN_ROLE"));

    await grantComponentRole(hre, accessManager, rm, "ORACLE_ADMIN_ROLE", owner);

    await expect(rm.setOracle(ZeroAddress)).to.be.revertedWith("PriceRiskModule: oracle_ cannot be the zero address");

    await expect(rm.setOracle(newOracle)).not.to.be.reverted;

    expect(await rm.oracle()).to.equal(newOracle);
  });

  it("Should only allow ORACLE_ADMIN to set the minDuration", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    expect(await rm.minDuration()).to.equal(HOUR);

    await expect(rm.setMinDuration(HOUR / 2)).to.be.revertedWith(accessControlMessage(owner, rm, "ORACLE_ADMIN_ROLE"));
    expect(await rm.minDuration()).to.equal(HOUR);

    await grantComponentRole(hre, accessManager, rm, "ORACLE_ADMIN_ROLE", owner);

    await expect(rm.setMinDuration(HOUR / 2)).not.to.be.reverted;

    expect(await rm.minDuration()).to.equal(HOUR / 2);
  });

  it("Should only allow PRICER to set CDFs", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    const newCdf = Array(Number(await rm.PRICE_SLOTS())).fill([0, 0, 0]);
    newCdf[0] = [_W("0.2"), _W("0.3"), _W("0.9")];
    newCdf[newCdf.length - 1] = [_W("0.5"), _W(0), _W(0)];

    expect((await rm.getCDF(1))[0][0]).to.equal(_W(0));
    expect((await rm.getCDF(1))[newCdf.length - 1][0]).to.equal(_W(0));

    await expect(rm.setCDF(1, newCdf)).to.be.revertedWith(accessControlMessage(owner, rm, "PRICER_ROLE"));

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);
    await expect(rm.connect(owner).setCDF(1, newCdf)).not.to.be.reverted;

    const actualCDF = await rm.getCDF(1);

    expect(actualCDF[0].lossProb).to.equal(_W("0.2"));
    expect(actualCDF[0].jrCollRatio).to.equal(_W("0.3"));
    expect(actualCDF[0].collRatio).to.equal(_W("0.9"));
    expect(actualCDF[newCdf.length - 1].lossProb).to.equal(_W("0.5"));
    expect(actualCDF[newCdf.length - 1].jrCollRatio).to.equal(_W("0"));
    expect(actualCDF[newCdf.length - 1].collRatio).to.equal(_W("0"));

    newCdf[newCdf.length - 2] = [_W("0.2"), _W("1.2"), _W(0)];
    await expect(rm.setCDF(1, newCdf)).to.be.revertedWith("Validation: invalid collateralization ratios");

    newCdf[newCdf.length - 2] = [_W("0.2"), _W("0.3"), _W("1.3")];
    await expect(rm.setCDF(1, newCdf)).to.be.revertedWith("Validation: invalid collateralization ratios");

    newCdf[newCdf.length - 2] = [_W("0.2"), _W("0.4"), _W("0.3")];
    await expect(rm.setCDF(1, newCdf)).to.be.revertedWith("Validation: invalid collateralization ratios");
  });

  it("Should not allow setting prices for policies with no duration", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    const newCdf = Array(Number(await rm.PRICE_SLOTS())).fill([0, 0, 0]);
    newCdf[0] = [_W("0.2"), _W("0.3"), _W("0.9")];
    newCdf[newCdf.length - 1] = [_W("0.5"), _W(0), _W(0)];

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    await expect(rm.connect(owner).setCDF(0, newCdf)).to.be.revertedWith("|duration| < 1");
  });

  it("Should not allow new policies if prices are not defined", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    // We don't have explicit validation againts current price = 0 because IPriceOracle must return
    // something != 0 or revert. Anyway, our code reverts anyway if a faulty IPriceOracle returns
    // getCurrentPrice() = 0.
    await expect(rm.pricePolicy(_E("100"), false, _A(1000), HOUR)).to.be.reverted;
    await expect(rm.pricePolicy(_E("100"), true, _A(1000), HOUR)).to.be.revertedWith("Price already at trigger value");
  });

  it("Should not allow address(0) for the policy owner", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await expect(
      rm.connect(cust).newPolicy(_E("1.1"), true, _A(1000), await helpers.time.latest(), ZeroAddress)
    ).to.be.revertedWith("onBehalfOf cannot be the zero address");
  });

  it("Should reject if trigger price has already been reached", async () => {
    const { pool, premiumsAccount } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await oracle.setPrice(_E("1.5"));

    await expect(rm.pricePolicy(_E("2"), true, _A(1000), HOUR)).to.be.revertedWith("Price already at trigger value");

    await expect(rm.pricePolicy(_E("1"), false, _A(1000), HOUR)).to.be.revertedWith("Price already at trigger value");
  });

  it("Should calculate policy premium and loss for single asset with no reference", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await oracle.setPrice(_E("0.00125")); // 1 ETH = 800 USDC

    const start = await helpers.time.latest();

    const [premium0, price0] = await rm.pricePolicy(_E("0.001"), true, _A(1000), start + HOUR * 2);
    expect(premium0).to.equal(0);
    expect(price0.lossProb).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    const priceSlots = Number(await rm.PRICE_SLOTS());

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) {
      cdf[i] = [_W(i / 100), 0, _W(1)];
    }
    cdf[26] = [_W("0.04"), _W("0.3"), _W("0.5")];
    cdf[priceSlots - 1] = [_W("0.5"), _W(0), _W(1)];
    await rm.connect(owner).setCDF(2, cdf);

    // With a variation of 0.4% we have the probability of the first slot
    let [premium, pricing] = await rm.pricePolicy(_E("0.00124502"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% we have the probability of the 12th slot
    [premium, pricing] = await rm.pricePolicy(_E("0.00109625"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));

    // With a variation of 26.6% we have the probability of the 27th slot
    [premium, pricing] = await rm.pricePolicy(_E("0.0009175"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));

    // With a variation of 25.8% we have the probability of the 26th slot
    [premium, pricing] = await rm.pricePolicy(_E("0.0009275"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.04"));
    expect(premium).to.equal(await rm.getMinimumPremiumForPricing(_A(1000), cdf[26], start + HOUR * 2));

    // With a variation of 46.6% we have the probability of the last slot
    [premium, pricing] = await rm.pricePolicy(_E("0.0006675"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));
  });

  it("Should not allow policy creation/triggering below min duration", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);
    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    // Setup pricing
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);
    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = [_W(i / 100), 0, _W(1)];
    cdf[priceSlots - 1] = [_W("0.5"), 0, _W(1)];
    await rm.connect(owner).setCDF(2, cdf);
    await rm.connect(owner).setCDF(3, cdf);

    // Setup min duration
    await grantComponentRole(hre, accessManager, rm, "ORACLE_ADMIN_ROLE", owner);
    await rm.setMinDuration(HOUR * 2);

    // Setup oracle
    await oracle.setPrice(_E("1.5"));

    const start = await helpers.time.latest();
    const triggerPrice = _E("1.1");

    // Duration = 2 hours is rejected
    await expect(rm.connect(cust).newPolicy(triggerPrice, true, _A(1000), start + HOUR * 2, cust)).to.be.revertedWith(
      "The policy expires too soon"
    );

    // Duration = 3 hours is accepted
    const expiration = start + HOUR * 3;
    const [premium, pricing] = await rm.pricePolicy(triggerPrice, true, _A(1000), expiration);
    expect(pricing.lossProb).to.be.equal(_W("0.27"));

    await currency.connect(cust).approve(pool, premium);

    const tx = await rm.connect(cust).newPolicy(triggerPrice, true, _A(1000), expiration, cust);
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args.policy.id;

    // The policy cannot be triggered within the next two hours, even if triggerPrice is reached
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1.05"));
    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Too soon to trigger the policy");

    // The policy can be triggered after the min duration
    await helpers.time.increase(HOUR);
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should allow policy creation of multiple policies with increasing internalId", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);
    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    // Setup pricing
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);
    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = [_W(i / 100), _W((i * 2) / 100), _W((i * 3) / 100)];
    await rm.connect(owner).setCDF(3, cdf);
    await rm.connect(owner).setCDF(-3, cdf);

    await oracle.setPrice(_E("1.5"));

    const start = await helpers.time.latest();
    const lowTriggerPrice = _E("1.1"); // slot = 27
    const highTriggerPrice = _E("1.8"); // slot = 20
    const expiration = start + HOUR * 3;

    const [premium, lowPricing] = await rm.pricePolicy(lowTriggerPrice, true, _A(1000), expiration);
    expect(lowPricing.lossProb).to.be.equal(_W("0.27"));
    expect(lowPricing.jrCollRatio).to.be.equal(_W("0.54"));
    expect(lowPricing.collRatio).to.be.equal(_W("0.81"));

    await currency.connect(cust).approve(pool, premium);

    const tx = await rm.connect(cust).newPolicy(lowTriggerPrice, true, _A(1000), expiration, cust);
    const receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const policyId = newPolicyEvt.args.policy.id;
    const MASK_96 = (BigInt(1) << BigInt(96)) - BigInt(1);
    expect(policyId & MASK_96).to.be.equal(1);
    expect(policyId).to.be.equal(makePolicyId(rm, 1));
    await expect(tx).to.emit(rm, "NewPricePolicy").withArgs(cust, policyId, lowTriggerPrice, true);

    expect(await rm.getPolicyData(policyId)).to.be.deep.equal([newPolicyEvt.args.policy, lowTriggerPrice, true]);

    const [hPremium, highPricing] = await rm.pricePolicy(highTriggerPrice, false, _A(100), expiration);
    expect(highPricing.lossProb).to.be.equal(_W("0.20"));
    expect(highPricing.jrCollRatio).to.be.equal(_W("0.40"));
    expect(highPricing.collRatio).to.be.equal(_W("0.60"));
    expect(hPremium).to.be.equal(_A("20.000685"));

    await currency.connect(cust).approve(pool, hPremium);
    const policyId2 = makePolicyId(rm, 2);
    await expect(rm.connect(cust).newPolicy(highTriggerPrice, false, _A(100), expiration, cust))
      .to.emit(rm, "NewPricePolicy")
      .withArgs(cust, policyId2, highTriggerPrice, false);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1.09"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));

    // getPolicyData remains the same even when the policy has triggered
    expect(await rm.getPolicyData(policyId)).to.be.deep.equal([newPolicyEvt.args.policy, lowTriggerPrice, true]);

    await oracle.setPrice(_E("1.80"));
    await expect(() => rm.triggerPolicy(policyId2)).to.changeTokenBalance(currency, cust, _A(100));

    expect((await rm.getPolicyData(policyId2))[1]).to.be.equal(highTriggerPrice);
    expect((await rm.getPolicyData(policyId2))[2]).to.be.equal(false);
  });

  it("Should calculate policy premium and loss probability (1% slots)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await oracle.setPrice(_E("1.5"));

    const start = await helpers.time.latest();

    const [price0, princing0] = await rm.pricePolicy(_E("1.1"), true, _A(1000), start + HOUR * 2);
    expect(price0).to.equal(0);
    expect(princing0.lossProb).to.equal(0);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    const priceSlots = Number(await rm.PRICE_SLOTS());

    const cdf = new Array(priceSlots);
    for (let i = 0; i < priceSlots; i++) cdf[i] = [_W(i / 100), 0, _W(1)];
    cdf[priceSlots - 1] = [_W("0.5"), 0, _W(1)];
    await rm.connect(owner).setCDF(2, cdf);

    // With a variation of 0.4% ($1.5 -> 1.494) we have the probability of the first slot
    let [premium, pricing] = await rm.pricePolicy(_E("1.494"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W(0));
    expect(premium).to.equal(_W(0));

    // With a variation of 12.3% ($1.5 -> $1.3155) we have the probability of the 12th slot
    [premium, pricing] = await rm.pricePolicy(_E("1.3155"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.12"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));

    // With a variation of 26.6% ($1.5 -> $1.1) we have the probability of the 27th slot
    [premium, pricing] = await rm.pricePolicy(_E("1.1"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.27"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));

    // With a variation of 46.6% ($1.5 -> $0.8) we have the probability of the last slot
    [premium, pricing] = await rm.pricePolicy(_E("0.8"), true, _A(1000), start + HOUR * 2);
    expect(pricing.lossProb).to.equal(_W("0.5"));
    expect(pricing.jrCollRatio).to.equal(_W("0"));
    expect(pricing.collRatio).to.equal(_W("1"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, start + HOUR * 2));
  });

  it("Should calculate policy premium and loss probability (13% slots)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount, undefined, _W("0.13"));

    await oracle.setPrice(_E("2000"));

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = Array(priceSlots).fill([0, 0, 0]);
    cdf[0] = [_W("0.5"), 0, _W(1)];
    cdf[2] = [_W("0.7"), 0, _W(1)];
    cdf[8] = [_W("0.001"), 0, _W(1)];
    await rm.connect(owner).setCDF(2, cdf);

    const start = await helpers.time.latest();
    const expiration = start + HOUR * 2;

    // With a variation of 0.4% ($2000 -> $1992) we have the probability of the first slot
    let [premium, pricing] = await rm.pricePolicy(_E("1992"), true, _A(1000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, expiration));

    // With a variation of 30% we have the probability of the 2nd slot
    [premium, pricing] = await rm.pricePolicy(_E("1400"), true, _A(1000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.7"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, expiration));

    // With a variation of 100% we have the probability of the 8th slot
    [premium, pricing] = await rm.pricePolicy(_E("0"), true, _A(1000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(1000), pricing.lossProb, expiration));
  });

  it("Should calculate policy premium and loss probability (5% slots, shorted asset)", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount, undefined, _W("0.05"));
    await oracle.setPrice(_E("2963.682"));

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = Array(priceSlots).fill([0, 0, 0]);
    cdf[0] = [_W("0.5"), 0, _W(1)];
    cdf[5] = [_W("0.03"), 0, _W(1)];
    cdf[20] = [_W("0.0001"), 0, _W(1)];
    cdf[priceSlots - 1] = [_W("0.000005"), 0, _W(1)];
    await rm.connect(owner).setCDF(-3, cdf);

    const start = await helpers.time.latest();
    const expiration = start + HOUR * 3;

    // With a variation of 0.000444% we have the probability of the first slot
    let [premium, pricing] = await rm.pricePolicy(_E("2965"), false, _A(2000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.5"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), pricing.lossProb, expiration));

    // With a variation of 27% we have the probability of the 5th slot
    [premium, pricing] = await rm.pricePolicy(_E("3763"), false, _A(2000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.03"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), pricing.lossProb, expiration));

    // With a variation of 100% we have the probability of the 20th slot
    [premium, pricing] = await rm.pricePolicy(_E("5928"), false, _A(2000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.0001"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), pricing.lossProb, expiration));

    // With a variation of 150% we have the probability of the last slot
    [premium, pricing] = await rm.pricePolicy(_E("7410"), false, _A(2000), expiration);
    expect(pricing.lossProb).to.equal(_W("0.000005"));
    expect(premium).to.equal(await rm.getMinimumPremium(_A(2000), pricing.lossProb, expiration));
  });

  it("Should trigger the policy only if threshold met", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await oracle.setPrice(_E("1.4"));

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    // Set price
    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = Array(priceSlots).fill([0, 0, 0]);
    cdf[20] = [_W("0.03"), 0, _W(1)];
    cdf[21] = [_W("0.05"), 0, _W(1)];
    cdf[priceSlots - 1] = [_W("0.1"), 0, _W(1)];
    await rm.connect(owner).setCDF(2, cdf);

    const start = await helpers.time.latest();
    const expiration = start + HOUR * 2;

    await expect(rm.connect(cust).newPolicy(_E("1.2"), true, _A(1000), expiration, cust)).to.be.revertedWith(
      "Either duration or percentage jump not supported"
    );

    const [premium, pricing] = await rm.pricePolicy(_E("1.1"), true, _A(1000), expiration);
    expect(pricing.lossProb).to.be.equal(_W("0.05"));

    await currency.connect(cust).approve(pool, premium);

    let tx = await rm.connect(cust).newPolicy(_E("1.1"), true, _A(1000), expiration, cust);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");

    const policyId = newPolicyEvt.args.policy.id;
    expect(policyId).to.equal(`${rm.target}000000000000000000000001`);

    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.05"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.05));

    expect(newPricePolicyEvt.args.lower).to.equal(true);
    expect(newPricePolicyEvt.args.policyId).to.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.equal(_W("1.1"));

    // Move time forward and refresh oracle with the same prices
    await helpers.time.increase(HOUR);

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice > triggerPrice");

    // Change price of asset to 1.1
    await oracle.setPrice(_E("1.1"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should trigger the policy only if threshold met - Shorted asset", async () => {
    const { pool, premiumsAccount, accessManager, currency } = await helpers.loadFixture(deployPoolFixture);

    const { rm, oracle } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await oracle.setPrice(_E("1.4"));

    // Set price
    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);
    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = Array(priceSlots).fill([0, 0, 0]);
    cdf[20] = [_W("0.02"), 0, _W(1)];
    cdf[21] = [_W("0.04"), 0, _W(1)];
    cdf[priceSlots - 1] = [_W("0.1"), 0, _W(1)];
    await rm.connect(owner).setCDF(-2, cdf);

    const start = await helpers.time.latest();

    const [premium, princing] = await rm.pricePolicy(_E("1.7"), false, _A(1000), start + HOUR * 2);
    expect(princing.lossProb).to.be.equal(_W("0.04"));
    await currency.connect(cust).approve(pool, premium);

    let tx = await rm.connect(cust).newPolicy(_E("1.7"), false, _A(1000), start + HOUR * 2, cust);
    let receipt = await tx.wait();
    const newPolicyEvt = getTransactionEvent(pool.interface, receipt, "NewPolicy");
    const newPricePolicyEvt = getTransactionEvent(rm.interface, receipt, "NewPricePolicy");
    const policyId = newPolicyEvt.args.policy.id;
    expect(policyId).to.equal(`${rm.target}000000000000000000000001`);
    expect(newPolicyEvt.args.policy.premium).to.closeTo(premium, _A(0.0001));
    expect(newPolicyEvt.args.policy.payout).to.equal(_A(1000));
    expect(newPolicyEvt.args.policy.lossProb).to.equal(_W("0.04"));
    expect(newPolicyEvt.args.policy.purePremium).to.equal(_A(1000 * 0.04));

    expect(newPricePolicyEvt.args.lower).to.equal(false);
    expect(newPricePolicyEvt.args.policyId).to.equal(policyId);
    expect(newPricePolicyEvt.args.triggerPrice).to.equal(_W("1.7"));

    // Move time forward and refresh oracle with the same prices
    await helpers.time.increase(HOUR);

    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Condition not met CurrentPrice < triggerPrice");

    // Change price of WMATIC to 1.75
    await oracle.setPrice(_E("1.75"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));
  });

  it("Should not allow operations when paused", async () => {
    const { pool, premiumsAccount, accessManager } = await helpers.loadFixture(deployPoolFixture);

    const { rm } = await addRiskModuleWithOracles(pool, premiumsAccount);

    await expect(rm.pause()).to.be.revertedWith(accessControlMessage(owner, rm, "GUARDIAN_ROLE"));
    expect(await rm.paused()).to.equal(false);

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", owner);
    await rm.pause();
    expect(await rm.paused()).to.equal(true);

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);
    const priceSlots = Number(await rm.PRICE_SLOTS());
    const cdf = Array(priceSlots).fill([0, 0, 0]);
    await expect(rm.setCDF(1, cdf)).to.be.revertedWith("Pausable: paused");

    await expect(
      rm.newPolicy(_E("1.1"), true, _A(1000), (await helpers.time.latest()) + HOUR, cust)
    ).to.be.revertedWith("Pausable: paused");
    await expect(rm.triggerPolicy(1)).to.be.revertedWith("Pausable: paused");

    await grantComponentRole(hre, accessManager, rm, "ORACLE_ADMIN_ROLE", owner);
    await expect(rm.setOracle(ZeroAddress)).to.be.revertedWith("Pausable: paused");

    await expect(rm.setMinDuration(1800)).to.be.revertedWith("Pausable: paused");
  });

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A("10000") },
      [lp, cust],
      [_A("8000"), _A("500")]
    );

    const pool = await deployPool({
      currency: currency,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const srEtk = await addEToken(pool, {});
    const jrEtk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: srEtk, jrEtk: jrEtk });

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    await currency.connect(lp).approve(pool, _A("8000"));
    await pool.connect(lp).deposit(srEtk, _A("5000"));
    await pool.connect(lp).deposit(jrEtk, _A("3000"));
    return { pool, currency, accessManager, jrEtk, srEtk, premiumsAccount };
  }
});

async function addRiskModuleWithOracles(
  pool,
  premiumsAccount,
  oracle = undefined,
  slotSize = _W("0.01"),
  price = undefined
) {
  if (oracle === undefined) {
    const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
    oracle = await PriceOracleMock.deploy(price || _W(0));
  }

  const rm = await addPriceRiskModule(pool, premiumsAccount, oracle, slotSize);

  return { oracle, rm };
}

async function addPriceRiskModule(pool, premiumsAccount, oracle, slotSize = _W("0.01")) {
  const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
  const oracleAddr = await ethers.resolveAddress(oracle);
  const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
    extraConstructorArgs: [slotSize],
    extraArgs: [oracleAddr],
  });

  return rm;
}
