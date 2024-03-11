const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress, ZeroHash } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const {
  _W,
  _E,
  amountFunction,
  grantComponentRole,
  makePolicyId,
  grantRole,
  accessControlMessage,
} = require("@ensuro/core/js/utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("@ensuro/core/js/test-utils");

const HOUR = 3600;

hre.upgrades.silenceWarnings();

describe("Test PayoutAutomationBase contract", function () {
  let cust, lp, owner;
  let _A;

  beforeEach(async () => {
    [owner, lp, cust] = await ethers.getSigners();

    const decimals = 6;
    _A = amountFunction(decimals);
  });

  it("Should fail if constructed with null address ", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    await expect(DummyPayoutAutomation.deploy(ZeroAddress)).to.be.revertedWith(
      "PayoutAutomationBase: policyPool_ cannot be the zero address"
    );
    await expect(DummyPayoutAutomation.deploy(pool)).not.to.be.reverted;
  });

  it("Should never allow reinitialization", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    await expect(fps.initialize("Another Name", "SYMB", lp)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Shouldn't be administrable if created without admin", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", ZeroAddress], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    await expect(grantRole(hre, fps.connect(owner), "GUARDIAN_ROLE", lp)).to.be.revertedWith(
      accessControlMessage(owner, null, "DEFAULT_ADMIN_ROLE")
    );
  });

  it("Should be upgradeable only by GUARDIAN_ROLE", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const ownerAddr = await ethers.resolveAddress(owner);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", ownerAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    await grantRole(hre, fps.connect(owner), "GUARDIAN_ROLE", lp);
    const newImpl = await DummyPayoutAutomation.deploy(pool);

    await expect(fps.connect(cust).upgradeTo(newImpl)).to.be.revertedWith(
      accessControlMessage(cust, null, "GUARDIAN_ROLE")
    );

    await expect(fps.connect(lp).upgradeTo(newImpl)).to.emit(fps, "Upgraded").withArgs(newImpl);
  });

  it("Should check event methods are only callable by the pool", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", ZeroAddress], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    await expect(fps.connect(cust).onERC721Received(pool, cust, 1, ZeroHash)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );

    await expect(fps.connect(cust).onPayoutReceived(pool, cust, 1, 0)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );

    await expect(fps.connect(cust).onPolicyExpired(pool, cust, 12)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );
  });

  it("Should initialize with name and symbol and permission granted to admin", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    expect(await fps.name()).to.be.equal("The Name");
    expect(await fps.symbol()).to.be.equal("SYMB");
    expect(await fps.hasRole(await fps.DEFAULT_ADMIN_ROLE(), lp)).to.equal(true);
    expect(await fps.hasRole(await fps.DEFAULT_ADMIN_ROLE(), owner)).to.equal(false);
  });

  it("Should support the expected interfaces", async () => {
    const { pool, DummyPayoutAutomation } = await helpers.loadFixture(deployPoolFixture);
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    const interfaceIds = {
      IERC165: "0x01ffc9a7",
      IERC20: "0x36372b07",
      IERC721: "0x80ac58cd",
      IAccessControl: "0x7965db0b",
      IAccessManager: "0x272b8c47",
      IPolicyHolder: "0x3ece0a89",
    };

    expect(await fps.supportsInterface(interfaceIds.IERC165)).to.be.equal(true);
    expect(await fps.supportsInterface(interfaceIds.IPolicyHolder)).to.be.equal(true);
    expect(await fps.supportsInterface(interfaceIds.IERC20)).to.be.equal(false);
    expect(await fps.supportsInterface(interfaceIds.IERC721)).to.be.equal(true);
    expect(await fps.supportsInterface(interfaceIds.IAccessControl)).to.be.equal(true);
  });

  it("Should mint an NFT if receiving a policy, and should burn it if recovered", async () => {
    const { pool, DummyPayoutAutomation, rm } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(1000), start + HOUR * 24, cust)).not.to.be.reverted;

    const policyId = makePolicyId(rm, 1);

    expect(await pool.ownerOf(policyId)).to.be.equal(cust);

    const safeTransferFrom = "safeTransferFrom(address,address,uint256)";

    await expect(pool.connect(cust)[safeTransferFrom](cust, fps, policyId))
      .to.emit(fps, "Transfer")
      .withArgs(ZeroAddress, cust, policyId);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust);

    await expect(fps.recoverPolicy(policyId)).to.be.revertedWith(
      "PayoutAutomationBase: you must own the NFT to recover the policy"
    );

    // Policy recovered by the customer
    await expect(fps.connect(cust).recoverPolicy(policyId))
      .to.emit(fps, "Transfer")
      .withArgs(cust, ZeroAddress, policyId);

    expect(await pool.ownerOf(policyId)).to.be.equal(cust);
    await expect(fps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Should mint an NFT if receiving a policy, and receive the payout if triggered", async () => {
    const { pool, DummyPayoutAutomation, rm, oracle } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    // Create two policies, one with 1400 as price and the other with 1200
    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(1000), start + HOUR * 24, cust)).not.to.be.reverted;

    const policyId = makePolicyId(rm, 1);

    await expect(rm.connect(cust).newPolicy(_W(1400), true, _A(700), start + HOUR * 24, cust)).not.to.be.reverted;

    const policyId2 = makePolicyId(rm, 2);

    const safeTransferFrom = "safeTransferFrom(address,address,uint256)";

    await expect(pool.connect(cust)[safeTransferFrom](cust, fps, policyId))
      .to.emit(fps, "Transfer")
      .withArgs(ZeroAddress, cust, policyId);

    await expect(pool.connect(cust)[safeTransferFrom](cust, fps, policyId2))
      .to.emit(fps, "Transfer")
      .withArgs(ZeroAddress, cust, policyId2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust);
    expect(await fps.balanceOf(cust)).to.be.equal(2);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(rm.triggerPolicy(policyId)).to.emit(fps, "Payout").withArgs(_A(1000), cust);

    expect(await fps.balanceOf(cust)).to.be.equal(1);

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy([...policy2])).not.to.be.reverted;

    expect(await fps.balanceOf(cust)).to.be.equal(0);

    // Pool NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    // But FPS NFTs are burnt
    await expect(fps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
    await expect(fps.ownerOf(policyId2)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Can create the policy through the FPS and works the same way", async () => {
    const { pool, DummyPayoutAutomation, rm, oracle, currency } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    // To use newPolicy you need to approve the fps as spender
    await expect(fps.connect(cust).newPolicy(rm, _W(1400), true, _A(1000), start + HOUR * 24, cust)).to.be.revertedWith(
      "ERC20: insufficient allowance"
    );

    await currency.connect(cust).approve(fps, _A(2000));

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm, 1);
    await expect(fps.connect(cust).newPolicy(rm, _W(1400), true, _A(1000), start + HOUR * 24, cust))
      .to.emit(fps, "Transfer")
      .withArgs(ZeroAddress, cust, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, fps, policyId);

    await expect(fps.connect(cust).newPolicy(rm, _W(1200), true, _A(700), start + HOUR * 24, cust)).not.to.be.reverted;

    const policyId2 = makePolicyId(rm, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust);

    // Fails with unsupported duration
    await expect(fps.connect(cust).newPolicy(rm, _W(1200), true, _A(700), start + HOUR * 48, cust)).to.be.revertedWith(
      "PayoutAutomationBase: premium = 0, policy not supported"
    );

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(rm.triggerPolicy(policyId)).to.emit(fps, "Payout").withArgs(_A(1000), cust);

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy([...policy2])).not.to.be.reverted;

    // Pool NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    // But FPS NFTs are burnt
    await expect(fps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
    await expect(fps.ownerOf(policyId2)).to.be.revertedWith("ERC721: invalid token ID");
  });

  it("Can create the policy through the FPS using permit", async () => {
    const { pool, DummyPayoutAutomation, rm, oracle, currency } = await helpers.loadFixture(deployPoolFixture);
    const start = await helpers.time.latest();
    const lpAddr = await ethers.resolveAddress(lp);
    const poolAddr = await ethers.resolveAddress(pool);
    const fps = await hre.upgrades.deployProxy(DummyPayoutAutomation, ["The Name", "SYMB", lpAddr], {
      kind: "uups",
      constructorArgs: [poolAddr],
    });

    // To use newPolicyWithPermit you need a valid signature
    const rmAddr = await ethers.resolveAddress(rm);
    const custAddr = await ethers.resolveAddress(cust);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rmAddr,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          custAddr,
          0,
          start + HOUR,
          0,
          ZeroHash,
          ZeroHash
        )
    ).to.be.revertedWith("ECDSA: invalid signature");

    const expiredSig = await makeEIP2612Signature(hre, currency, cust, fps, _A(1), start);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust,
          _A(1),
          start,
          expiredSig.v,
          expiredSig.r,
          expiredSig.s
        )
    ).to.be.revertedWith("ERC20Permit: expired deadline");

    const otherUserSig = await makeEIP2612Signature(hre, currency, lp, fps, _A(1), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust,
          _A(1),
          start + HOUR,
          otherUserSig.v,
          otherUserSig.r,
          otherUserSig.s
        )
    ).to.be.revertedWith("ERC20Permit: invalid signature");

    const notEnoughSig = await makeEIP2612Signature(hre, currency, cust, fps, _A(1), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust,
          _A(1),
          start + HOUR,
          notEnoughSig.v,
          notEnoughSig.r,
          notEnoughSig.s
        )
    ).to.be.revertedWith("ERC20: insufficient allowance");

    const okSig = await makeEIP2612Signature(hre, currency, cust, fps, _A(2000), start + HOUR);

    // Create two policies, one with 1400 as price and the other with 1200
    const policyId = makePolicyId(rm, 1);
    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1400),
          true,
          _A(1000),
          start + HOUR * 24,
          cust,
          _A(2000),
          start + HOUR,
          okSig.v,
          okSig.r,
          okSig.s
        )
    )
      .to.emit(fps, "Transfer")
      .withArgs(ZeroAddress, cust, policyId)
      .to.emit(pool, "Transfer")
      .withArgs(ZeroAddress, fps, policyId);

    // Reuse of the same signature doesn't work
    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1200),
          true,
          _A(700),
          start + HOUR * 24,
          cust,
          _A(2000),
          start + HOUR,
          okSig.v,
          okSig.r,
          okSig.s
        )
    ).to.be.revertedWith("ERC20Permit: invalid signature");

    const okSig2 = await makeEIP2612Signature(hre, currency, cust, fps, _A(200), start + HOUR);

    await expect(
      fps
        .connect(cust)
        .newPolicyWithPermit(
          rm,
          _W(1200),
          true,
          _A(700),
          start + HOUR * 24,
          cust,
          _A(200),
          start + HOUR,
          okSig2.v,
          okSig2.r,
          okSig2.s
        )
    ).not.to.be.reverted;

    const policyId2 = makePolicyId(rm, 2);

    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId)).to.be.equal(cust);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    expect(await fps.ownerOf(policyId2)).to.be.equal(cust);

    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    await expect(rm.triggerPolicy(policyId)).to.emit(fps, "Payout").withArgs(_A(1000), cust);

    await helpers.time.increase(HOUR * 24);
    const policy2 = (await rm.getPolicyData(policyId2))[0];
    await expect(pool.expirePolicy(policy2)).not.to.be.reverted;

    // Pool NFT ownership doesn't changes when policies are triggered or expired
    expect(await pool.ownerOf(policyId)).to.be.equal(fps);
    expect(await pool.ownerOf(policyId2)).to.be.equal(fps);
    // But FPS NFTs are burnt
    await expect(fps.ownerOf(policyId)).to.be.revertedWith("ERC721: invalid token ID");
    await expect(fps.ownerOf(policyId2)).to.be.revertedWith("ERC721: invalid token ID");
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
      verifyingContract: token,
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
    const nonces = await token.nonces(owner);

    // set the Permit type values
    const values = {
      owner: owner,
      spender: spenderAddress,
      value: value,
      nonce: nonces,
      deadline: deadline,
    };

    // sign the Permit type data with the deployer's private key
    const signature = await owner.signTypedData(domain, types, values);

    // split the signature into its components
    const sig = ethers.Signature.from(signature);
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
        await currency.transfer(user, initial_balances[index]);
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
    await currency.connect(cust).approve(pool, _A("500"));
    await pool.connect(lp).deposit(srEtk, _A("5000"));
    await pool.connect(lp).deposit(jrEtk, _A("3000"));

    const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
    const oracle = await PriceOracleMock.deploy(_W(1500));
    const oracleAddr = await ethers.resolveAddress(oracle);

    const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
    const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
      extraConstructorArgs: [_W("0.01")],
      extraArgs: [oracleAddr],
    });

    await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

    const newCdf = Array(Number(await rm.PRICE_SLOTS())).fill([_W("0.01"), _W("0.05"), _W("1.0")]);
    await rm.setCDF(24, newCdf);

    const DummyPayoutAutomation = await ethers.getContractFactory("DummyPayoutAutomation");

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
      DummyPayoutAutomation,
    };
  }
});
