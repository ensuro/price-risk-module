const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { AddressZero, HashZero } = ethers.constants;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { _W, _E, amountFunction, grantComponentRole, makePolicyId } = require("@ensuro/core/js/utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("@ensuro/core/js/test-utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test PayoutStrategyBase contract", function () {
  let cust, lp, owner;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

    const decimals = 6;
    _A = amountFunction(decimals);
  });

  it("Should fail if constructed with null address ", async () => {
    const { pool, ForwardPayoutStrategy } = await helpers.loadFixture(deployPoolFixture);
    await expect(ForwardPayoutStrategy.deploy(AddressZero)).to.be.revertedWith(
      "PayoutStrategyBase: policyPool_ cannot be the zero address"
    );
    await expect(ForwardPayoutStrategy.deploy(pool.address)).not.to.be.reverted;
  });

  it("Should initialize with name and symbol and permission granted to admin", async () => {
    const { pool, ForwardPayoutStrategy } = await helpers.loadFixture(deployPoolFixture);
    const fps = await hre.upgrades.deployProxy(ForwardPayoutStrategy, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address],
    });

    expect(await fps.name()).to.be.equal("The Name");
    expect(await fps.symbol()).to.be.equal("SYMB");
    expect(await fps.hasRole(await fps.DEFAULT_ADMIN_ROLE(), lp.address)).to.equal(true);
    expect(await fps.hasRole(await fps.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(false);
  });

  it("Should mint an NFT if receiving a policy, and should burn it if recovered", async () => {
    const { pool, ForwardPayoutStrategy, rm } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const fps = await hre.upgrades.deployProxy(ForwardPayoutStrategy, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address],
    });

    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(1000), start + HOUR * 24, cust.address)).not.to.be
      .reverted;

    const policyId = makePolicyId(rm.address, 1);

    expect(await pool.ownerOf(policyId)).to.be.equal(cust.address);

    const safeTransferFrom = "safeTransferFrom(address,address,uint256)";

    await expect(pool.connect(cust)[safeTransferFrom](cust.address, fps.address, policyId))
      .to.emit(fps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);

    await expect(fps.recoverPolicy(policyId)).to.be.revertedWith(
      "PayoutStrategyBase: you must own the NFT to recover the policy"
    );

    // Policy recovered by the customer
    await expect(fps.connect(cust).recoverPolicy(policyId))
      .to.emit(fps, "Transfer")
      .withArgs(cust.address, AddressZero, policyId);

    expect(await pool.ownerOf(policyId)).to.be.equal(cust.address);
    await expect(fps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Should mint an NFT if receiving a policy, and receive the payout if triggered", async () => {
    const { pool, ForwardPayoutStrategy, rm, oracle, currency } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const fps = await hre.upgrades.deployProxy(ForwardPayoutStrategy, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address],
    });

    // Create two policies, one with 1400 as price and the other with 1200
    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(1000), start + HOUR * 24, cust.address)).not.to.be
      .reverted;

    const policyId = makePolicyId(rm.address, 1);

    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(700), start + HOUR * 24, cust.address)).not.to.be
      .reverted;

    const policyId2 = makePolicyId(rm.address, 2);

    const safeTransferFrom = "safeTransferFrom(address,address,uint256)";

    await expect(pool.connect(cust)[safeTransferFrom](cust.address, fps.address, policyId))
      .to.emit(fps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId);

    await expect(pool.connect(cust)[safeTransferFrom](cust.address, fps.address, policyId2))
      .to.emit(fps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);
  });

  it("Can create the policy through the FPS and works the same way", async () => {
    const { pool, ForwardPayoutStrategy, rm, oracle, currency } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const fps = await hre.upgrades.deployProxy(ForwardPayoutStrategy, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address],
    });

    // To use newPolicy you need to approve the fps as spender
    await expect(
      fps.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address)
    ).to.be.revertedWith("ERC20: insufficient allowance");

    await currency.connect(cust).approve(fps.address, _A(2000));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.address, 1);
    await expect(fps.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address))
      .to.emit(fps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(AddressZero, fps.address, policyId);

    await expect(fps.connect(cust).newPolicy(rm.address, _W(1200), true, _A(700), start + HOUR * 24, cust.address)).not
      .to.be.reverted;

    const policyId2 = makePolicyId(rm.address, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);
  });

  it("Can create the policy through the FPS using permit", async () => {
    const { pool, ForwardPayoutStrategy, rm, oracle, currency } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const fps = await hre.upgrades.deployProxy(ForwardPayoutStrategy, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address],
    });

    // To use newPolicyWithPermit you need a valid signature
    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust.address,
          0,
          start + HOUR,
          0,
          HashZero,
          HashZero
        )
    ).to.be.revertedWith("ECDSA: invalid signature");

    const expiredSig = await makeEIP2612Signature(hre, currency, cust, fps.address, _A(1), start);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust.address,
          _A(1),
          start,
          expiredSig.v,
          expiredSig.r,
          expiredSig.s
        )
    ).to.be.revertedWith("ERC20Permit: expired deadline");

    const otherUserSig = await makeEIP2612Signature(hre, currency, lp, fps.address, _A(1), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust.address,
          _A(1),
          start + HOUR,
          otherUserSig.v,
          otherUserSig.r,
          otherUserSig.s
        )
    ).to.be.revertedWith("ERC20Permit: invalid signature");

    const notEnoughSig = await makeEIP2612Signature(hre, currency, cust, fps.address, _A(1), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust.address,
          _A(1),
          start + HOUR,
          notEnoughSig.v,
          notEnoughSig.r,
          notEnoughSig.s
        )
    ).to.be.revertedWith("ERC20: insufficient allowance");

    const okSig = await makeEIP2612Signature(hre, currency, cust, fps.address, _A(2000), start + HOUR);

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm.address, 1);
    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust.address,
          _A(2000),
          start + HOUR,
          okSig.v,
          okSig.r,
          okSig.s
        )
    )
      .to.emit(fps, "Transfer")
      .withArgs(AddressZero, cust.address, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(AddressZero, fps.address, policyId);

    // Reuse of the same signature doesn't work
    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1200),
          true,
          _A(700),
          start + HOUR * 24,
          cust.address,
          _A(2000),
          start + HOUR,
          okSig.v,
          okSig.r,
          okSig.s
        )
    ).to.be.revertedWith("ERC20Permit: invalid signature");

    const okSig2 = await makeEIP2612Signature(hre, currency, cust, fps.address, _A(200), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm.address,
          _W(1200),
          true,
          _A(700),
          start + HOUR * 24,
          cust.address,
          _A(200),
          start + HOUR,
          okSig2.v,
          okSig2.r,
          okSig2.s
        )
    ).not.to.be.reverted;

    const policyId2 = makePolicyId(rm.address, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(() => rm.triggerPolicy(policyId)).to.changeTokenBalance(currency, cust, _A(1000));

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust.address);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps.address);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust.address);
  });

  // eslint-disable-next-line no-shadow
  async function makeEIP2612Signature(hre, token, owner, spenderAddress, value, deadline = HOUR) {
    // From: https://www.quicknode.com/guides/ethereum-development/transactions/how-to-use-erc20-permit-approval
    const chainId = hre.network.config.chainId;
    // set the domain parameters
    const domain = {
      name: await token.name(),
      version: "1",
      chainId: chainId,
      verifyingContract: token.address,
    };

    // set the Permit type parameters
    const types = {
      Permit: [
        {
          name: "owner",
          type: "address",
        },
        {
          name: "spender",
          type: "address",
        },
        {
          name: "value",
          type: "uint256",
        },
        {
          name: "nonce",
          type: "uint256",
        },
        {
          name: "deadline",
          type: "uint256",
        },
      ],
    };

    if (deadline < 1600000000) {
      // Is a duration in seconds
      deadline = (await helpers.time.latest()) + deadline;
    }

    // get the current nonce for the deployer address
    const nonces = await token.nonces(owner.address);

    // set the Permit type values
    const values = {
      owner: owner.address,
      spender: spenderAddress,
      value: value,
      nonce: nonces,
      deadline: deadline,
    };

    // sign the Permit type data with the deployer's private key
    const signature = await owner._signTypedData(domain, types, values);

    // split the signature into its components
    const sig = ethers.utils.splitSignature(signature);
    return sig;
  }

  // Function copied from @ensuro/core/js/test-utils.js - When we add support for ERC20Permit in
  // Ensuro we can remove it
  async function initCurrency(options, initial_targets, initial_balances) {
    const Currency = await hre.ethers.getContractFactory(options.contract || "TestCurrency");
    let currency = await Currency.deploy(
      options.name || "Test Currency",
      options.symbol || "TEST",
      options.initial_supply,
      options.decimals || 18
    );
    initial_targets = initial_targets || [];
    await Promise.all(
      initial_targets.map(async function (user, index) {
        await currency.transfer(user.address, initial_balances[index]);
      })
    );
    return currency;
  }

  async function deployPoolFixture() {
    const currency = await initCurrency(
      { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A("10000"), contract: "TestCurrencyPermit" },
      [lp, cust],
      [_A("8000"), _A("500")]
    );

    const pool = await deployPool({
      currency: currency.address,
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

    const ForwardPayoutStrategy = await ethers.getContractFactory("ForwardPayoutStrategy");

    return {
      pool,
      currency,
      accessManager,
      jrEtk,
      srEtk,
      premiumsAccount,
      rm,
      oracle,
      PriceRiskModule,
      PriceOracleMock,
      ForwardPayoutStrategy,
    };
  }
});
