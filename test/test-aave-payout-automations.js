const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { AddressZero, MaxUint256 } = ethers.constants;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { _W, _E, amountFunction, grantComponentRole, makePolicyId } = require("@ensuro/core/js/utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("@ensuro/core/js/test-utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test AAVE payout automation contracts", function () {
  let cust, cust2, lp, owner;
  let _A;

  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    aaveV3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usrUSDC: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Random account with lot of USDC

    // From USDC reserve data
    aUSDC: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",
    aUSDCDebtStable: "0x307ffe186F84a3bc2613D1eA417A5737D69A7007",
    aUSDCDebtVariable: "0xFCCf3cAbbe80101232d343252614b6A3eE81C989",

    wmatic: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    ensuroTreasury: "0x913B9dff6D780cF4cda0b0321654D7261d5593d0", // Random address
    etk: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    variableDebtmUSDC: "0x248960A9d75EdFa3de94F7193eae3161Eb349a12",
    oracle: "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d", // AAVE PriceOracle
    sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // Sushiswap router
    assetMgr: "0x09d9Dd252659a497F3525F257e204E7192beF132",
    usrWMATIC: "0x55FF76BFFC3Cdd9D5FdbBC2ece4528ECcE45047e", // Random account with log of WMATIC
  };

  beforeEach(async () => {
    [owner, lp, cust, cust2] = await ethers.getSigners();

    const decimals = 6;
    _A = amountFunction(decimals);
  });

  it("Should fail if constructed with null address ", async () => {
    const { pool, AAVERepayPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    await expect(AAVERepayPayoutAutomation.deploy(AddressZero, AddressZero)).to.be.revertedWith(
      "PayoutAutomationBase: policyPool_ cannot be the zero address"
    );
    await expect(AAVERepayPayoutAutomation.deploy(pool.address, AddressZero)).to.be.revertedWith(
      "AAVERepayPayoutAutomation: you must specify AAVE's Pool address"
    );
    await expect(AAVERepayPayoutAutomation.deploy(pool.address, ADDRESSES.aaveV3)).not.to.be.reverted;
  });

  it("Should never allow reinitialization", async () => {
    const { pool, AAVERepayPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const ps = await hre.upgrades.deployProxy(AAVERepayPayoutAutomation, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, ADDRESSES.aaveV3],
    });

    await expect(ps.initialize("Another Name", "SYMB", lp.address)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Should do infinite approval on initialization", async () => {
    const { pool, AAVERepayPayoutAutomation, currency } = await helpers.loadFixture(deployPoolFixture);
    const ps = await hre.upgrades.deployProxy(AAVERepayPayoutAutomation, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, ADDRESSES.aaveV3],
    });

    expect(await currency.allowance(ps.address, ADDRESSES.aaveV3)).to.be.equal(MaxUint256);
  });

  it("Can create the policy through the ps and since there's no debt, deposits in AAVE", async () => {
    const { pool, AAVERepayPayoutAutomation, rm, oracle, currency, aUSDC } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const ps = await hre.upgrades.deployProxy(AAVERepayPayoutAutomation, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, ADDRESSES.aaveV3],
    });

    await currency.connect(cust).approve(ps.address, _A(2000));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.address, 1);
    await expect(ps.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(AddressZero, ps.address, policyId);

    await expect(ps.connect(cust).newPolicy(rm.address, _W(1200), true, _A(700), start + HOUR * 24, cust.address)).not
      .to.be.reverted;

    const policyId2 = makePolicyId(rm.address, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(ps.address);
    expect(await ps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.address);
    expect(await ps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(aUSDC, cust, _A(1000));

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // Pool NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(ps.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.address);
    // But FPS NFTs are burnt
    await expect(ps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
    await expect(ps.ownerOf(policyId2)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Can create policies that when triggered repay stable and variable debt", async () => {
    const {
      pool,
      AAVERepayPayoutAutomation,
      rm,
      oracle,
      currency,
      aave,
      aUSDCDebtStable,
      aUSDCDebtVariable,
      wmatic,
      aUSDC,
    } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const ps = await hre.upgrades.deployProxy(AAVERepayPayoutAutomation, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, ADDRESSES.aaveV3],
    });

    await currency.connect(cust).approve(ps.address, MaxUint256);

    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtStable, cust, _E("10000"), _A(1300));
    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtVariable, cust2, _E("10000"), _A(800));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.address, 1);
    await expect(ps.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(AddressZero, ps.address, policyId);

    // Paid by cust, but onBehalfOf cust2
    await expect(ps.connect(cust).newPolicy(rm.address, _W(1200), true, _A(700), start + HOUR * 24, cust2.address)).not
      .to.be.reverted;

    const policyId2 = makePolicyId(rm.address, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(ps.address);
    expect(await ps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(ps.address);
    expect(await ps.ownerOf(policyId2)).to.be.equal(cust2.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1190"));

    // Repays stable debt
    let before = await aUSDCDebtStable.balanceOf(cust.address);
    await expect(rm.triggerPolicy(policyId))
      .to.emit(currency, "Transfer")
      .withArgs(ps.address, aUSDC.address, _A(1000));
    expect(before.sub(await aUSDCDebtStable.balanceOf(cust.address))).to.be.closeTo(_A(1000), _A("0.0001"));

    // Repays variable debt
    before = await aUSDCDebtVariable.balanceOf(cust2.address);
    await expect(rm.triggerPolicy(policyId2))
      .to.emit(currency, "Transfer")
      .withArgs(ps.address, aUSDC.address, _A(700));
    expect(before.sub(await aUSDCDebtVariable.balanceOf(cust2.address))).to.be.closeTo(_A(700), _A("0.0001"));
  });

  it("Can create policies that when triggered repay mixed stable and variable debt", async () => {
    const {
      pool,
      AAVERepayPayoutAutomation,
      rm,
      oracle,
      currency,
      aave,
      aUSDCDebtStable,
      aUSDCDebtVariable,
      wmatic,
      aUSDC,
    } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const ps = await hre.upgrades.deployProxy(AAVERepayPayoutAutomation, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, ADDRESSES.aaveV3],
    });

    await currency.connect(cust).approve(ps.address, MaxUint256);

    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtStable, cust, _E("5000"), _A(300));
    await depositAndTakeDebt(aave, currency, wmatic, aUSDCDebtVariable, cust, _E("5000"), _A(400));

    const policyId = makePolicyId(rm.address, 1);
    await expect(ps.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(ps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(AddressZero, ps.address, policyId);

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
    expect(await aUSDC.balanceOf(cust.address)).to.be.closeTo(_A(300), _A("0.01"));
  });

  async function depositAndTakeDebt(aave, usdc, wmatic, debtToken, user, depositAmount, borrowAmount) {
    await wmatic.connect(user).approve(aave.address, MaxUint256);
    await aave.connect(user).deposit(wmatic.address, depositAmount, user.address, 0);
    await aave
      .connect(user)
      .borrow(usdc.address, borrowAmount, debtToken.address == ADDRESSES.aUSDCDebtStable ? 1 : 2, 0, user.address);
    expect(await debtToken.balanceOf(user.address)).to.be.closeTo(borrowAmount, _A("0.0001"));
  }

  async function deployPoolFixture() {
    if (process.env.ALCHEMY_URL === undefined) throw new Error("Define envvar ALCHEMY_URL for this test");
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 47719249, // polygon mainnet
          },
        },
      ],
    });

    await helpers.impersonateAccount(ADDRESSES.usrUSDC);
    await helpers.setBalance(ADDRESSES.usrUSDC, 100n ** 18n);
    lp = await hre.ethers.getSigner(ADDRESSES.usrUSDC);

    const currency = await ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);

    const aave = await ethers.getContractAt("IPool", ADDRESSES.aaveV3);
    const aUSDC = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDC);
    const aUSDCDebtVariable = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDCDebtVariable);
    const aUSDCDebtStable = await ethers.getContractAt("IERC20Metadata", ADDRESSES.aUSDCDebtStable);

    // Transfer some wmatic and USDC to the customers
    const wmatic = await ethers.getContractAt("IERC20Metadata", ADDRESSES.wmatic);

    await helpers.impersonateAccount(ADDRESSES.usrWMATIC);
    await helpers.setBalance(ADDRESSES.usrWMATIC, 100n ** 18n);
    const usrWMATIC = await hre.ethers.getSigner(ADDRESSES.usrWMATIC);
    await wmatic.connect(usrWMATIC).transfer(cust.address, _E("10000"));
    await wmatic.connect(usrWMATIC).transfer(cust2.address, _E("10000"));

    await currency.connect(lp).transfer(cust.address, _A(500));

    const pool = await deployPool({
      currency: ADDRESSES.usdc,
      grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
      treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
    });
    pool._A = _A;

    const srEtk = await addEToken(pool, {});
    const jrEtk = await addEToken(pool, {});

    const premiumsAccount = await deployPremiumsAccount(pool, {
      srEtkAddr: srEtk.address,
      jrEtkAddr: jrEtk.address,
    });

    const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

    await currency.connect(lp).approve(pool.address, _A("8000"));
    await currency.connect(cust).approve(pool.address, _A("500"));
    await pool.connect(lp).deposit(srEtk.address, _A("5000"));
    await pool.connect(lp).deposit(jrEtk.address, _A("3000"));

    const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
    const oracle = await PriceOracleMock.deploy(_W(1500));

    const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [_W("0.01")],
      extraArgs: [oracle.address],
    });

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

    const newCdf = Array(await rm.PRICE_SLOTS()).fill([_W("0.01"), _W("0.05"), _W("1.0")]);
    await rm.setCDF(24, newCdf);

    const AAVERepayPayoutAutomation = await ethers.getContractFactory("AAVERepayPayoutAutomation");

    return {
      pool,
      currency,
      wmatic,
      aave,
      aUSDC,
      aUSDCDebtStable,
      aUSDCDebtVariable,
      accessManager,
      jrEtk,
      srEtk,
      premiumsAccount,
      rm,
      oracle,
      PriceRiskModule,
      PriceOracleMock,
      AAVERepayPayoutAutomation,
    };
  }
});
