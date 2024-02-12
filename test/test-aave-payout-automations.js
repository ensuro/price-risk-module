const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress, MaxUint256 } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { _W, _E, amountFunction, grantComponentRole, makePolicyId } = require("@ensuro/core/js/utils");
const {
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
  initForkCurrency,
} = require("@ensuro/core/js/test-utils");
const { fork } = require("./utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test AAVE payout automation contracts", function () {
  let _A;

  const ADDRESSES = {
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    aaveV3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Random account with lot of USDC

    // From USDC reserve data
    aUSDC: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
    aUSDCDebtStable: "0x307ffe186F84a3bc2613D1eA417A5737D69A7007",
    aUSDCDebtVariable: "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",

    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    MATICWhale: "0x55FF76BFFC3Cdd9D5FdbBC2ece4528ECcE45047e", // Random account with lot of WMATIC
    aWMATIC: "0x6d80113e533a2C0fe82EaBD35f1875DcEA89Ea97",

    AUTOMATE: "0x527a819db1eb0e34426297b03bae11F2f8B3A19E",
    SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  };

  beforeEach(async () => {
    const decimals = 6;
    _A = amountFunction(decimals);
  });

  ["AAVERepayPayoutAutomation", "AAVEBuyEthPayoutAutomation"].forEach((contractName) => {
    it(`Should fail if constructed with null address - ${contractName}`, async () => {
      const { pool, ...others } = await helpers.loadFixture(deployPoolFixture);
      const contractClass = others[contractName];
      await expect(
        contractClass.deploy(ZeroAddress, ADDRESSES.AUTOMATE, ADDRESSES.WMATIC, ZeroAddress)
      ).to.be.revertedWith("PayoutAutomationBase: policyPool_ cannot be the zero address");
      await expect(
        contractClass.deploy(pool.target, ADDRESSES.AUTOMATE, ADDRESSES.WMATIC, ZeroAddress)
      ).to.be.revertedWith(`${contractName}: you must specify AAVE's Pool address`);
      await expect(contractClass.deploy(pool.target, ADDRESSES.AUTOMATE, ADDRESSES.WMATIC, ADDRESSES.aaveV3)).not.to.be
        .reverted;
    });

    it(`Should never allow reinitialization - ${contractName}`, async () => {
      const { pool, maticOracle, lp, ...others } = await helpers.loadFixture(deployPoolFixture);
      const contractClass = others[contractName];
      const ps = await hre.upgrades.deployProxy(
        contractClass,
        ["The Name", "SYMB", lp.address, maticOracle.target, ADDRESSES.SwapRouter, _A("0.0005")],
        {
          kind: "uups",
          constructorArgs: [pool.target, ADDRESSES.AUTOMATE, ADDRESSES.WMATIC, ADDRESSES.aaveV3],
        }
      );

      await expect(
        ps.initialize("Another Name", "SYMB", lp.address, maticOracle.target, ADDRESSES.SwapRouter, _A("0.0005"))
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });

  it("Should do infinite approval on initialization - AAVERepayPayoutAutomation", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { ps, currency } = await deployPoolWRepayAutoFixture(ret);
    expect(await currency.allowance(ps.target, ADDRESSES.aaveV3)).to.be.equal(MaxUint256);
  });

  it("Should do infinite approval on initialization - AAVEBuyEthPayoutAutomation", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { ps, wmatic } = await deployPoolWBuyEthAutoFixture(ret);
    expect(await wmatic.allowance(ps.target, ADDRESSES.aaveV3)).to.be.equal(MaxUint256);
  });

  it("Can create the policy through the ps and since there's no debt, deposits in AAVE", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { pool, ps, rm, oracle, currency, aUSDC, cust } = await deployPoolWRepayAutoFixture(ret);
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(ps.target, _A(2000));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.target, 1);
    await expect(ps.connect(cust).newPolicy(rm.target, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(ZeroAddress, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, ps.target, policyId);

    await expect(ps.connect(cust).newPolicy(rm.target, _W(1200), true, _A(700), start + HOUR * 24, cust.address)).not.to
      .be.reverted;

    const policyId2 = makePolicyId(rm.target, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(aUSDC, cust, _A("999.992919"));

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // Pool NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(ps.target);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.target);
    // But FPS NFTs are burnt
    await expect(ps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
    await expect(ps.ownerOf(policyId2)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Can create policies that when triggered repay stable and variable debt", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { pool, ps, rm, oracle, currency, aave, aUSDCDebtStable, aUSDCDebtVariable, wmatic, aUSDC, cust, cust2 } =
      await deployPoolWRepayAutoFixture(ret);
    const start = await helpers.time.latest();

    await currency.connect(cust).approve(ps.target, MaxUint256);

    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtStable, cust, _E("10000"), _A(1300));
    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtVariable, cust2, _E("10000"), _A(800));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.target, 1);
    await expect(ps.connect(cust).newPolicy(rm.target, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(ZeroAddress, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, ps.target, policyId);

    // Paid by cust, but onBehalfOf cust2
    await expect(ps.connect(cust).newPolicy(rm.target, _W(1200), true, _A(700), start + HOUR * 24, cust2.address)).not
      .to.be.reverted;

    const policyId2 = makePolicyId(rm.target, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId2)).to.be.equal(cust2.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1190"));

    // Repays stable debt
    let before = await aUSDCDebtStable.balanceOf(cust.address);
    await expect(rm.triggerPolicy(policyId)).to.emit(currency, "Transfer").withArgs(ps.target, aUSDC.target, anyUint);
    expect(before.sub(await aUSDCDebtStable.balanceOf(cust.address))).to.be.closeTo(_A(1000), _A("0.01"));

    // Repays variable debt
    before = await aUSDCDebtVariable.balanceOf(cust2.address);
    await expect(rm.triggerPolicy(policyId2)).to.emit(currency, "Transfer").withArgs(ps.target, aUSDC.target, anyUint);
    expect(before.sub(await aUSDCDebtVariable.balanceOf(cust2.address))).to.be.closeTo(_A(700), _A("0.01"));
  });

  it("Can create policies that when triggered repay mixed stable and variable debt", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { pool, ps, rm, oracle, currency, aave, aUSDCDebtStable, aUSDCDebtVariable, wmatic, aUSDC, cust } =
      await deployPoolWRepayAutoFixture(ret);
    const start = await helpers.time.latest();

    await currency.connect(cust).approve(ps.target, MaxUint256);

    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtStable, cust, _E("5000"), _A(300));
    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtVariable, cust, _E("5000"), _A(400));

    const policyId = makePolicyId(rm.target, 1);
    await expect(ps.connect(cust).newPolicy(rm.target, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(ZeroAddress, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, ps.target, policyId);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));

    // Repays stable debt
    // let before = {
    //   usdc: await currency.balanceOf(cust.address),
    //   stable: await aUSDCDebtStable.balanceOf(cust.address),
    //   variable: await aUSDCDebtVariable.balanceOf(cust.address),
    // };
    await expect(rm.triggerPolicy(policyId))
      .to.emit(currency, "Transfer")
      //      .withArgs(ps.address, aUSDC.address, before.stable)
      .to.emit(currency, "Transfer")
      //      .withArgs(ps.address, aUSDC.address, before.variable)
      .to.emit(currency, "Transfer");
    //      .withArgs(ps.address, aUSDC.address, _A(1000).sub(before.stable.add(before.variable)));
    // Disabled the .withArgs because it might have small differences

    expect(await aUSDCDebtStable.balanceOf(cust.address)).to.be.equal(0);
    expect(await aUSDCDebtVariable.balanceOf(cust.address)).to.be.equal(0);
    expect(await aUSDC.balanceOf(cust.address)).to.be.closeTo(_A(300), _A("0.05"));
  });

  it("Can create the policy through the BuyEth ps and deposits in AAVE", async () => {
    const ret = await helpers.loadFixture(deployPoolFixture);
    const { pool, ps, rm, oracle, currency, aave, cust, wmatic, aWMATIC, maticOracle } =
      await deployPoolWBuyEthAutoFixture(ret);
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(ps.target, _A(2000));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.target, 1);
    await expect(ps.connect(cust).newPolicy(rm.target, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(ZeroAddress, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, ps.target, policyId);

    await expect(ps.connect(cust).newPolicy(rm.target, _W(1200), true, _A("0.005"), start + HOUR * 24, cust.address))
      .not.to.be.reverted;

    const policyId2 = makePolicyId(rm.target, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.target);
    expect(await ps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));

    // Uniswap Price is ~0.53 - Setting the oracle at 0.5 should revert the operation
    await maticOracle.setPrice(_E("0.5"));
    await expect(rm.triggerPolicy(policyId)).to.be.revertedWith("Too little received");

    // In this case should be accepted because even when Uni price is more expensive, is within 2% accepted
    // difference
    await maticOracle.setPrice(_E("0.52"));

    await expect(rm.triggerPolicy(policyId))
      .to.emit(aave, "Supply")
      .withArgs(wmatic.target, ps.target, cust.address, _E("1888.408885662289522076"), 0);

    expect(await aWMATIC.balanceOf(cust.address)).to.be.closeTo(_E("1888.40"), _E("0.10"));

    // Trying to trigger policyId2 fails because payout is not enough to cover Gelato's fee
    await oracle.setPrice(_E("1190"));
    await expect(rm.triggerPolicy(policyId2)).to.be.revertedWith(
      "AAVEBuyEthPayoutAutomation: the payout is not enough to cover the tx fees"
    );

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;
  });

  async function depositAndTakeDebt(aave, usdc, wmatic, debtToken, user, depositAmount, borrowAmount) {
    await wmatic.connect(user).approve(aave.target, MaxUint256);
    await aave.connect(user).deposit(wmatic.target, depositAmount, user.address, 0);
    await aave
      .connect(user)
      .borrow(usdc.target, borrowAmount, debtToken.target == ADDRESSES.aUSDCDebtStable ? 1 : 2, 0, user.address);
    expect(await debtToken.balanceOf(user.address)).to.be.closeTo(borrowAmount, _A("0.0001"));
  }

  async function deployPoolFixture() {
    fork(47719249);

    const [owner, lp, cust, cust2, gelato, ...signers] = await ethers.getSigners();

    const currency = await initForkCurrency(
      ADDRESSES.USDC,
      ADDRESSES.USDCWhale,
      [lp, cust, cust2],
      [_A("10000"), _A("10000"), _A("10000")]
    );

    const aave = await ethers.getContractAt("IPool", ADDRESSES.aaveV3);

    // Transfer some wmatic to the customers
    const wmatic = await ethers.getContractAt("IERC20Metadata", ADDRESSES.WMATIC);

    await helpers.impersonateAccount(ADDRESSES.MATICWhale);
    await helpers.setBalance(ADDRESSES.MATICWhale, 100n ** 18n);
    const MATICWhale = await hre.ethers.getSigner(ADDRESSES.MATICWhale);
    await wmatic.connect(MATICWhale).transfer(cust.address, _E("10000"));
    await wmatic.connect(MATICWhale).transfer(cust2.address, _E("10000"));

    await currency.connect(lp).transfer(cust.address, _A(500));

    const pool = await deployPool({
      currency: ADDRESSES.USDC,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const srEtk = await addEToken(pool, {});
    const jrEtk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(pool, {
      srEtkAddr: srEtk.target,
      jrEtkAddr: jrEtk.target,
    });

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    await currency.connect(lp).approve(pool.target, _A("8000"));
    await currency.connect(cust).approve(pool.target, _A("500"));
    await pool.connect(lp).deposit(srEtk.target, _A("5000"));
    await pool.connect(lp).deposit(jrEtk.target, _A("3000"));

    const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
    const oracle = await PriceOracleMock.deploy(_W(1500));
    const maticOracle = await PriceOracleMock.deploy(_W("0.6"));

    const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [_W("0.01")],
      extraArgs: [oracle.target],
    });

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const newCdf = Array(await rm.PRICE_SLOTS()).fill([_W("0.01"), _W("0.05"), _W("1.0")]);
    await rm.setCDF(24, newCdf);

    const AAVERepayPayoutAutomation = await ethers.getContractFactory("AAVERepayPayoutAutomation");
    const AAVEBuyEthPayoutAutomation = await ethers.getContractFactory("AAVEBuyEthPayoutAutomation");

    return {
      pool,
      currency,
      wmatic,
      aave,
      accessManager,
      jrEtk,
      srEtk,
      premiumsAccount,
      rm,
      oracle,
      maticOracle,
      PriceRiskModule,
      PriceOracleMock,
      AAVERepayPayoutAutomation,
      AAVEBuyEthPayoutAutomation,
      lp,
      cust,
      cust2,
      gelato,
      signers,
    };
  }

  async function deployPoolWRepayAutoFixture(ret) {
    const AutomateMock = await ethers.getContractFactory("AutomateMock");
    const automate = await AutomateMock.deploy(ret.gelato.address);

    const ps = await hre.upgrades.deployProxy(
      ret.AAVERepayPayoutAutomation,
      ["The Name", "SYMB", ret.lp.address, ret.maticOracle.target, ADDRESSES.SwapRouter, _A("0.0005")],
      {
        kind: "uups",
        constructorArgs: [ret.pool.target, automate.target, ADDRESSES.WMATIC, ADDRESSES.aaveV3],
      }
    );

    const aUSDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDC);
    const aUSDCDebtVariable = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDCDebtVariable);
    const aUSDCDebtStable = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDCDebtStable);

    return {
      ps,
      automate,
      AutomateMock,
      aUSDC,
      aUSDCDebtStable,
      aUSDCDebtVariable,
      ...ret,
    };
  }

  async function deployPoolWBuyEthAutoFixture(ret) {
    const AutomateMock = await ethers.getContractFactory("AutomateMock");
    const automate = await AutomateMock.deploy(ret.gelato.address);

    const ps = await hre.upgrades.deployProxy(
      ret.AAVEBuyEthPayoutAutomation,
      ["The Name", "SYMB", ret.lp.address, ret.maticOracle.target, ADDRESSES.SwapRouter, _A("0.0005")],
      {
        kind: "uups",
        constructorArgs: [ret.pool.target, automate.target, ADDRESSES.WMATIC, ADDRESSES.aaveV3],
      }
    );
    const aWMATIC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aWMATIC);
    return {
      ps,
      automate,
      AutomateMock,
      aWMATIC,
      ...ret,
    };
  }
});
