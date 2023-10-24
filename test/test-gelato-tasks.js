const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { MaxUint256, AddressZero } = ethers.constants;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const {
  _E,
  _W,
  accessControlMessage,
  amountFunction,
  getTransactionEvent,
  grantComponentRole,
  grantRole,
  makePolicyId,
} = require("@ensuro/core/js/utils");
const {
  addEToken,
  addRiskModule,
  deployPool,
  deployPremiumsAccount,
  initForkCurrency,
  setupChain,
} = require("@ensuro/core/js/test-utils");

const { HOUR } = require("@ensuro/core/js/constants");

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);

const ADDRESSES = {
  // polygon mainnet addresses
  automate: "0x527a819db1eb0e34426297b03bae11F2f8B3A19E",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
};

// enum
const Module = {
  RESOLVER: 0,
  TIME: 1,
  PROXY: 2,
  SINGLE_EXEC: 3,
};

function rightPaddedFunctionSelector(contract, signature) {
  return ethers.BigNumber.from(contract.interface.getSighash(signature)).shl(256 - 32);
}

hre.upgrades.silenceWarnings();

describe("Test Gelato Task Creation / Execution", function () {
  it("ForwardPayoutAutomation can be constructed with policy pool and gelato's address", async () => {
    const { pool, ForwardPayoutAutomation, automate } = await helpers.loadFixture(deployPoolFixture);
    await expect(ForwardPayoutAutomation.deploy(pool.address, automate.address, ADDRESSES.WMATIC)).not.to.be.reverted;

    await expect(ForwardPayoutAutomation.deploy(pool.address, automate.address, AddressZero)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: WETH address cannot be zero"
    );
  });

  it("Should never allow reinitialization", async () => {
    const { fpa, lp, oracle } = await helpers.loadFixture(deployPoolFixture);

    await expect(
      fpa.initialize("Another Name", "SYMB", lp.address, oracle.address, ADDRESSES.SwapRouter, _A("0.0005"))
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Requires all parameters on initialization", async () => {
    const { pool, ForwardPayoutAutomation, automate, oracle, admin } = await helpers.loadFixture(deployPoolFixture);

    const fpa = await ForwardPayoutAutomation.deploy(pool.address, automate.address, ADDRESSES.WMATIC);
    await fpa.deployed();

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, AddressZero, ADDRESSES.SwapRouter, _A("0.0005"))
    ).to.be.revertedWith("PayoutAutomationBaseGelato: oracle address cannot be zero");

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, oracle.address, AddressZero, _A("0.0005"))
    ).to.be.revertedWith("PayoutAutomationBaseGelato: SwapRouter address cannot be zero");

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, oracle.address, ADDRESSES.SwapRouter, _A(0))
    ).to.be.revertedWith("PayoutAutomationBaseGelato: feeTier cannot be zero");

    await expect(fpa.initialize("The Name", "SYMB", admin.address, oracle.address, ADDRESSES.SwapRouter, _A("0.0005")))
      .to.emit(fpa, "OracleSet")
      .withArgs(oracle.address)
      .to.emit(fpa, "SwapRouterSet")
      .withArgs(ADDRESSES.SwapRouter)
      .to.emit(fpa, "FeeTierSet")
      .withArgs(_A("0.0005"))
      .to.emit(fpa, "PriceToleranceSet")
      .withArgs(_W("0.02"));
  });

  it("Allows setting oracle", async () => {
    const { fpa, oracle, lp, guardian, signers } = await helpers.loadFixture(deployPoolFixture);

    expect(await fpa.oracle()).to.equal(oracle.address);
    await expect(fpa.connect(lp).setOracle(AddressZero)).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    await expect(fpa.connect(guardian).setOracle(AddressZero)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: oracle address cannot be zero"
    );
    await expect(fpa.connect(guardian).setOracle(signers[1].address) /* some random address */)
      .to.emit(fpa, "OracleSet")
      .withArgs(signers[1].address);
    expect(await fpa.oracle()).to.equal(signers[1].address);
  });

  it("Allows setting swap router", async () => {
    const { fpa, lp, guardian, signers } = await helpers.loadFixture(deployPoolFixture);

    expect(await fpa.swapRouter()).to.equal(ADDRESSES.SwapRouter);
    await expect(fpa.connect(lp).setSwapRouter(AddressZero)).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    await expect(fpa.connect(guardian).setSwapRouter(AddressZero)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: SwapRouter address cannot be zero"
    );
    await expect(fpa.connect(guardian).setSwapRouter(signers[1].address) /* some random address */)
      .to.emit(fpa, "SwapRouterSet")
      .withArgs(signers[1].address);
    expect(await fpa.swapRouter()).to.equal(signers[1].address);
  });

  it("Allows setting feeTier", async () => {
    const { fpa, lp, guardian } = await helpers.loadFixture(deployPoolFixture);

    expect(await fpa.feeTier()).to.equal(_A("0.0005"));
    await expect(fpa.connect(lp).setFeeTier(_A(0))).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    await expect(fpa.connect(guardian).setFeeTier(_A(0))).to.be.revertedWith(
      "PayoutAutomationBaseGelato: feeTier cannot be zero"
    );
    await expect(fpa.connect(guardian).setFeeTier(_A("0.0001")))
      .to.emit(fpa, "FeeTierSet")
      .withArgs(_A("0.0001"));
    expect(await fpa.feeTier()).to.equal(_A("0.0001"));
  });

  it("Allows setting prceTolerance", async () => {
    const { fpa, lp, guardian } = await helpers.loadFixture(deployPoolFixture);

    expect(await fpa.priceTolerance()).to.equal(_W("0.02"));
    await expect(fpa.connect(lp).setPriceTolerance(_W(0))).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    await expect(fpa.connect(guardian).setPriceTolerance(_W(0))).to.be.revertedWith(
      "PayoutAutomationBaseGelato: priceTolerance cannot be zero"
    );
    await expect(fpa.connect(guardian).setPriceTolerance(_W("0.0001")))
      .to.emit(fpa, "PriceToleranceSet")
      .withArgs(_W("0.0001"));
    expect(await fpa.priceTolerance()).to.equal(_W("0.0001"));
  });

  it("Creates a policy resolution task when a policy is created", async () => {
    const { fpa, automate, rm, cust, currency, oracle } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy
    const tx = await fpa
      .connect(cust)
      .newPolicy(rm.address, _W("0.6"), true, _A(1000), start + HOUR * 24, cust.address);

    // A task was created
    const triggerPolicySelector = rightPaddedFunctionSelector(rm, "triggerPolicy(uint256)");
    await expect(tx)
      .to.emit(automate, "TaskCreated")
      .withArgs(anyValue, rm.address, triggerPolicySelector, anyValue, ADDRESSES.ETH);

    // Workaround broken struct match - https://github.com/NomicFoundation/hardhat/issues/3833
    const receipt = await tx.wait();
    const event = await getTransactionEvent(automate.interface, receipt, "TaskCreated");
    const resolverArgs = ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes"],
      [fpa.address, fpa.interface.encodeFunctionData("checker", [rm.address, makePolicyId(rm.address, 1)])]
    );
    expect(event.args[3]).to.deep.equal([[Module.RESOLVER], [resolverArgs]]);

    // The check for the task returns canExec = False
    const [canExec] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec).to.be.false;

    // When the price drops the check still returns canExec = False because minDuration has not elapsed
    await oracle.setPrice(_E("0.59"));
    const [canExec2] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec2).to.be.false;

    // After minDuration elapses it returns true
    await helpers.time.increase(HOUR);
    const [canExec3] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec3).to.be.true;
  });

  it("Pays for gelato tx fee when resolving policies", async () => {
    const { pool, fpa, rm, cust, currency, oracle, gelato, automate } = await helpers.loadFixture(deployPoolFixture);

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Initial price is 0.62 USDC per MATIC
    await oracle.setPrice(_W("0.62"));

    // Create a new policy that triggers under $0.57
    const creationTx = await fpa
      .connect(cust)
      .newPolicy(rm.address, _W("0.57"), true, _A(1000), start + HOUR * 24, cust.address);
    const taskCreatedEvent = await getTransactionEvent(automate.interface, await creationTx.wait(), "TaskCreated");

    // Price drops below trigger price
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));

    // Task can now be executed
    const [canExec, payload] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec).to.be.true;

    // Gelato triggers the policy
    const tx = await gelato.sendTransaction({ to: rm.address, data: payload });

    // Sanity check
    await expect(tx).to.emit(pool, "PolicyResolved").withArgs(rm.address, makePolicyId(rm.address, 1), _A(1000));

    // The fee was paid to gelato
    await expect(tx).to.changeEtherBalance(gelato, _W("0.013371337"));

    // The rest of the payout was transferred to the policy holder
    await expect(tx).to.changeTokenBalance(currency, cust, _A("999.992491") /* $1000 payout - $0.007509 fee */);

    // The task was removed from gelato
    await expect(tx).to.emit(automate, "TaskCancelled").withArgs(taskCreatedEvent.args.taskId, fpa.address);
  });
});

// TODO: task cancelation on expiration

async function deployPoolFixture() {
  setupChain(48475972);

  const [owner, lp, cust, gelato, admin, guardian, ...signers] = await ethers.getSigners();

  const currency = await initForkCurrency(ADDRESSES.USDC, ADDRESSES.USDCWhale, [lp, cust], [_A("8000"), _A("500")]);

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

  await currency.connect(lp).approve(pool.address, MaxUint256);
  await currency.connect(cust).approve(pool.address, MaxUint256);
  await pool.connect(lp).deposit(srEtk.address, _A("5000"));
  await pool.connect(lp).deposit(jrEtk.address, _A("3000"));

  const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
  const oracle = await PriceOracleMock.deploy(_W("0.62"));

  const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
  const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
    extraConstructorArgs: [_W("0.01")],
    extraArgs: [oracle.address],
  });

  await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner.address);

  const newCdf = Array(await rm.PRICE_SLOTS()).fill([_W("0.01"), _W("0.05"), _W("1.0")]);
  await rm.setCDF(24, newCdf);

  const AutomateMock = await ethers.getContractFactory("AutomateMock");
  const automate = await AutomateMock.deploy(gelato.address);

  const ForwardPayoutAutomation = await ethers.getContractFactory("ForwardPayoutAutomation");
  const fpa = await hre.upgrades.deployProxy(
    ForwardPayoutAutomation,
    ["The Name", "SYMB", admin.address, oracle.address, ADDRESSES.SwapRouter, _A("0.0005")],
    {
      kind: "uups",
      constructorArgs: [pool.address, automate.address, ADDRESSES.WMATIC],
    }
  );

  await grantRole(hre, fpa.connect(admin), "GUARDIAN_ROLE", guardian);

  return {
    accessManager,
    admin,
    automate,
    AutomateMock,
    currency,
    cust,
    ForwardPayoutAutomation,
    fpa,
    gelato,
    guardian,
    jrEtk,
    lp,
    oracle,
    owner,
    pool,
    premiumsAccount,
    PriceOracleMock,
    PriceRiskModule,
    rm,
    signers,
    srEtk,
  };
}
