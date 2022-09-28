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
} = require("@ensuro/core/js/test-utils");

hre.upgrades.silenceWarnings();

describe("Test PriceRiskModule contract", function () {
  let owner, lp, cust;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await hre.ethers.getSigners();

    _A = amountFunction(6);
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

    const start = (await owner.provider.getBlock("latest")).timestamp;
    await expect(rm.pricePolicy(_A(100), true, _A(1000), start + 3600)).to.be.revertedWith("Price from not available");

    await priceOracle.setAssetPrice(wmatic.address, _E("0.0005")); // 1 ETH = 2000 WMATIC

    await expect(rm.pricePolicy(_A(100), true, _A(1000), start + 3600)).to.be.revertedWith("Price to not available");

    await priceOracle.setAssetPrice(currency.address, _E("0.000333333")); // 1 ETH = 3000 USDC

    // 1 WMATIC = 1.5 USDC

    await expect(rm.pricePolicy(_A(2), true, _A(1000), start + 3600)).to.be.revertedWith(
      "Price already at trigger value"
    );

    await expect(rm.pricePolicy(_A(1), false, _A(1000), start + 3600)).to.be.revertedWith(
      "Price already at trigger value"
    );

    let [price0, lossProb0] = await rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const priceSlots = await rm.PRICE_SLOTS();

    const cdf = _makeArray(priceSlots, 0);

    cdf[0] = _W("0.1");
    cdf[priceSlots - 1] = _W("0.1");
    await rm.connect(owner).setCDF(1, cdf);

    [price0, lossProb0] = await rm.pricePolicy(_A(1.1), true, _A(1000), start + 3600);
    expect(price0).to.equal(0);
    expect(lossProb0).to.equal(0);

    const [premium, lossProb] = await rm.pricePolicy(_A(0.8), true, _A(1000), start + 3600);
    expect(lossProb).to.be.equal(_W("0.1"));

    expect(await rm.getMinimumPremium(_A(1000), lossProb, start + 3600)).to.be.equal(premium);
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

  it("Should trigger the policy only if threshold met - Upper variant", async () => {
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
