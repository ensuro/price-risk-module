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
  getRole,
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
  AUTOMATE: "0x527a819db1eb0e34426297b03bae11F2f8B3A19E",
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
    const { pool, ForwardPayoutAutomation, automate } = await helpers.loadFixture(forwardPayoutAutomationFixture);
    await expect(ForwardPayoutAutomation.deploy(pool.address, automate.address, ADDRESSES.WMATIC)).not.to.be.reverted;

    await expect(ForwardPayoutAutomation.deploy(pool.address, automate.address, AddressZero)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: WETH address cannot be zero"
    );
  });

  it("Should never allow reinitialization", async () => {
    const { fpa, lp, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    let swapCustomParams = ethers.utils.defaultAbiCoder.encode(
      ["uint24", "address"],
      [_A("0.0005"), ADDRESSES.SwapRouter]
    );

    await expect(
      fpa.initialize("Another Name", "SYMB", lp.address, oracle.address, [1, _W(0), swapCustomParams])
    ).to.be.revertedWith("Initializable: contract is already initialized");
  });

  it("Should check event methods are only callable by the pool", async () => {
    const { fpa, pool, lp } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await expect(fpa.connect(lp).onPayoutReceived(pool.address, lp.address, 1, 0)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );

    await expect(fpa.connect(lp).onPolicyExpired(pool.address, lp.address, 12)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );
  });

  it("Requires all parameters on initialization", async () => {
    const { pool, ForwardPayoutAutomation, automate, oracle, admin } = await helpers.loadFixture(
      forwardPayoutAutomationFixture
    );

    const fpa = await ForwardPayoutAutomation.deploy(pool.address, automate.address, ADDRESSES.WMATIC);
    await fpa.deployed();

    let swapCustomParams = ethers.utils.defaultAbiCoder.encode(
      ["uint24", "address"],
      [_A("0.0005"), ADDRESSES.SwapRouter]
    );

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, oracle.address, [1, _W(0), swapCustomParams])
    ).to.be.revertedWith("SwapLibrary: maxSlippage cannot be zero");

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, AddressZero, [1, _W("0.02"), swapCustomParams])
    ).to.be.revertedWith("PayoutAutomationBaseGelato: oracle address cannot be zero");

    let routerZeroAddr = ethers.utils.defaultAbiCoder.encode(["uint24", "address"], [_A("0.0005"), AddressZero]);

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, oracle.address, [1, _W("0.02"), routerZeroAddr])
    ).to.be.revertedWith("SwapLibrary: SwapRouter address cannot be zero");

    let zeroFeeTier = ethers.utils.defaultAbiCoder.encode(["uint24", "address"], [_A(0), ADDRESSES.SwapRouter]);

    await expect(
      fpa.initialize("The Name", "SYMB", admin.address, oracle.address, [1, _W("0.02"), zeroFeeTier])
    ).to.be.revertedWith("SwapLibrary: feeTier cannot be zero");

    await expect(fpa.initialize("The Name", "SYMB", admin.address, oracle.address, [1, _W("0.02"), swapCustomParams]))
      .to.emit(fpa, "OracleSet")
      .withArgs(oracle.address)
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([1, _W("0.02"), swapCustomParams]);
  });

  it("Allows setting oracle", async () => {
    const { fpa, oracle, lp, guardian, signers } = await helpers.loadFixture(forwardPayoutAutomationFixture);

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

  it("Only GUARDIAN can set swap config", async () => {
    const { fpa, swapDefaultParams, lp, guardian, signers } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await expect(fpa.connect(lp).setSwapConfig([1, _W("0.1"), swapDefaultParams])).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    await expect(fpa.connect(lp).setOracle(AddressZero)).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    // some random address as router
    let randomAddr = ethers.utils.defaultAbiCoder.encode(["uint24", "address"], [_A("0.0005"), signers[1].address]);
    await expect(fpa.connect(guardian).setSwapConfig([1, _W("0.07"), randomAddr]))
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([1, _W("0.07"), randomAddr]);

    await expect(fpa.connect(guardian).setOracle(signers[1].address))
      .to.emit(fpa, "OracleSet")
      .withArgs(signers[1].address);
    expect(await fpa.oracle()).to.equal(signers[1].address);
  });

  it("Allows setting swap config", async () => {
    const { fpa, lp, swapDefaultParams, guardian, signers } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    let swapConfig = await fpa.swapConfig();
    expect(swapConfig.protocol).to.equal(1);
    expect(swapConfig.maxSlippage).to.equal(_W("0.02"));
    expect(swapConfig.customParams).to.equal(swapDefaultParams);
    await expect(fpa.connect(lp).setSwapConfig([1, _W("0.05"), swapDefaultParams])).to.be.revertedWith(
      accessControlMessage(lp.address, null, "GUARDIAN_ROLE")
    );

    let routerZeroAddr = ethers.utils.defaultAbiCoder.encode(["uint24", "address"], [_A("0.0005"), AddressZero]);
    await expect(fpa.connect(guardian).setSwapConfig([1, _W("0.02"), routerZeroAddr])).to.be.revertedWith(
      "SwapLibrary: SwapRouter address cannot be zero"
    );

    await expect(fpa.connect(guardian).setSwapConfig([3, _W("0.04"), swapDefaultParams])).to.be.reverted;

    await expect(fpa.connect(guardian).setSwapConfig([0, _W("0.04"), swapDefaultParams])).to.be.revertedWith(
      "SwapLibrary: Invalid Protocol"
    );

    // some random address as router
    let randomAddr = ethers.utils.defaultAbiCoder.encode(["uint24", "address"], [_A("0.0005"), signers[1].address]);
    await expect(fpa.connect(guardian).setSwapConfig([1, _W("0.06"), randomAddr]))
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([1, _W("0.06"), randomAddr]);

    swapConfig = await fpa.swapConfig();
    expect(swapConfig.protocol).to.equal(1);
    expect(swapConfig.maxSlippage).to.equal(_W("0.06"));
    expect(swapConfig.customParams).to.equal(randomAddr);
  });

  it("Creates a policy resolution task when a policy is created", async () => {
    const { fpa, automate, rm, cust, currency, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

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
    const { pool, fpa, rm, cust, currency, oracle, gelato, automate } = await helpers.loadFixture(
      forwardPayoutAutomationFixture
    );

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

  it("Removes task on expiration", async () => {
    const { pool, fpa, rm, cust, currency, automate } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy that expires in 24 hours
    const creationTx = await fpa
      .connect(cust)
      .newPolicy(rm.address, _W("0.57"), true, _A(1000), start + HOUR * 24, cust.address);
    const taskCreatedEvent = await getTransactionEvent(automate.interface, await creationTx.wait(), "TaskCreated");

    // Policy expires
    await helpers.time.increase(HOUR * 24);
    const policy = (await rm.getPolicyData(makePolicyId(rm.address, 1)))[0];
    const tx = await pool.expirePolicy(policy);

    // The task has been cancelled
    await expect(tx).to.emit(automate, "TaskCancelled").withArgs(taskCreatedEvent.args.taskId, fpa.address);

    // No funds were transferred to or from the customer
    await expect(tx).to.changeTokenBalance(currency, cust, 0);

    // No funds were transferred to or from the payout automation contract
    await expect(tx).to.changeTokenBalance(currency, fpa, 0);
    await expect(tx).to.changeEtherBalance(fpa, 0);
  });

  it("Gives 0 allowance to the swap router on initialization", async () => {
    const { fpa, currency, cust, rm, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    // Initialized contract has 0 allowance on the router
    expect(await currency.allowance(fpa.address, ADDRESSES.SwapRouter)).to.equal(0);

    // Creating / resolving policies does not change allowance
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(fpa.address, _A(2000));
    await fpa.connect(cust).newPolicy(rm.address, _W("0.57"), true, _A(1000), start + HOUR * 24, cust.address);
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));
    await rm.triggerPolicy(makePolicyId(rm.address, 1));
  });
});

describe("SwapRouterMock", () => {
  it("Works with payout automation", async () => {
    const { fpa, gelato, guardian, currency, admin, cust, rm, oracle, swapRouter, wmatic } = await helpers.loadFixture(
      swapRouterMockFixture
    );
    // Allow the payout automation contract to perform swaps
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", fpa);

    // Use the mock swapRouter in the payout automation
    const swapDefaultParams = ethers.utils.defaultAbiCoder.encode(
      ["uint24", "address"],
      [_A("0.0005"), swapRouter.address]
    );
    await fpa.connect(guardian).setSwapConfig([1, _W("0.05"), swapDefaultParams]);

    // Create and trigger a policy
    const start = await helpers.time.latest();
    await oracle.setPrice(_W("0.62"));
    await currency.connect(cust).approve(fpa.address, _A(2000));
    await fpa.connect(cust).newPolicy(rm.address, _W("0.57"), true, _A(1000), start + HOUR * 24, cust.address);
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));
    const tx = await rm.triggerPolicy(makePolicyId(rm.address, 1));

    // The exchange was made using the swap router funds
    await expect(tx).to.changeEtherBalance(gelato, _W("0.013371337")); // sanity check that the fee was paid
    await expect(tx).to.changeTokenBalance(wmatic, swapRouter, _W("-0.013371337"));
    await expect(tx).to.changeTokenBalance(currency, swapRouter, _A("0.007474") /* $0.007474 fee */);
  });

  it("Only allows withdrawing funds to guardian", async () => {
    const { guardian, currency, signers, swapRouter, wmatic } = await helpers.loadFixture(swapRouterMockFixture);

    expect(await swapRouter.hasRole(getRole("GUARDIAN_ROLE"), signers[1].address)).to.be.false;
    await expect(swapRouter.connect(signers[1]).withdraw(ADDRESSES.ETH, _W(1))).to.be.revertedWith(
      accessControlMessage(signers[1].address, null, "GUARDIAN_ROLE")
    );
    await expect(swapRouter.connect(signers[1]).withdraw(currency.address, _A(100))).to.be.revertedWith(
      accessControlMessage(signers[1].address, null, "GUARDIAN_ROLE")
    );

    await expect(swapRouter.connect(guardian).withdraw(wmatic.address, _W(1))).to.changeTokenBalance(
      wmatic,
      guardian,
      _W(1)
    );
    await expect(swapRouter.connect(guardian).withdraw(currency.address, _A(100))).to.changeTokenBalance(
      currency,
      guardian,
      _A(100)
    );
  });

  it("Can do exactInputSingle swaps", async () => {
    const { currency, admin, oracle, marketMaker, swapRouter, wmatic } = await helpers.loadFixture(
      swapRouterMockFixture
    );

    const swapExactInputParams = [
      currency.address, // address tokenIn;
      wmatic.address, // address tokenOut;
      100, // uint24 fee;
      marketMaker.address, // address recipient;
      (await helpers.time.latest()) + 3600, // uint256 deadline;
      _A("10"), // uint256 amountIn;
      _W("15"), // uint256 amountOutMinimum;
      0, // uint160 sqrtPriceLimitX96;
    ];
    await expect(swapRouter.connect(marketMaker).exactInputSingle(swapExactInputParams)).to.be.revertedWith(
      accessControlMessage(marketMaker.address, null, "SWAP_ROLE")
    );
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", marketMaker);
    await currency.connect(marketMaker).approve(swapRouter.address, _A(10));
    await oracle.setPrice(_W("0.64"));
    const swapTx = await swapRouter.connect(marketMaker).exactInputSingle(swapExactInputParams);
    await expect(swapTx).to.changeTokenBalance(currency, marketMaker, _A("-10"));
    await expect(swapTx).to.changeTokenBalance(wmatic, marketMaker, _W("15.625"));
  });

  it("Supports a configurable slippage", async () => {
    const { guardian, currency, admin, cust, oracle, marketMaker, swapRouter, wmatic } = await helpers.loadFixture(
      swapRouterMockFixture
    );
    expect(await swapRouter.slippage()).to.equal(_W("1"));
    await expect(swapRouter.connect(cust).setSlippage(_W("0.01"))).to.be.revertedWith(
      accessControlMessage(cust.address, null, "GUARDIAN_ROLE")
    );
    await expect(swapRouter.connect(guardian).setSlippage(_W("1.02")))
      .to.emit(swapRouter, "SlippageUpdated")
      .withArgs(_W("1.02"));

    await oracle.setPrice(_W("0.62")); // 1 MATIC = $0.62 + 2% = $0.6324.
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", marketMaker);
    await currency.connect(marketMaker).approve(swapRouter.address, _A(10));

    let swapExactOutputParams = await makeExactOutputParams(marketMaker.address, _W("1"), _A("0.63"));
    await expect(swapRouter.connect(marketMaker).exactOutputSingle(swapExactOutputParams)).to.be.revertedWith(
      "amountInMaximum exceeded"
    );

    swapExactOutputParams = await makeExactOutputParams(marketMaker.address, _W("1"), _A("0.6324"));
    const swapOutputTx = await swapRouter.connect(marketMaker).exactOutputSingle(swapExactOutputParams);
    await expect(swapOutputTx).to.changeTokenBalance(currency, marketMaker, _A("-0.6324"));
    await expect(swapOutputTx).to.changeTokenBalance(wmatic, marketMaker, _W("1"));

    const swapExactInputParams = [
      currency.address, // address tokenIn;
      wmatic.address, // address tokenOut;
      100, // uint24 fee;
      marketMaker.address, // address recipient;
      (await helpers.time.latest()) + 3600, // uint256 deadline;
      _A("0.6324"), // uint256 amountIn;
      _W("1"), // uint256 amountOutMinimum;
      0, // uint160 sqrtPriceLimitX96;
    ];

    const swapInputTx = await swapRouter.connect(marketMaker).exactInputSingle(swapExactInputParams);
    await expect(swapInputTx).to.changeTokenBalance(currency, marketMaker, _A("-0.6324"));
    await expect(swapInputTx).to.changeTokenBalance(wmatic, marketMaker, _W("1"));
  });

  async function makeExactOutputParams(recipient, amountOut, amountInMaximum, params) {
    params = params || {};
    return [
      params.tokenIn || ADDRESSES.USDC, // address tokenIn;
      params.tokenOut || ADDRESSES.WMATIC, // address tokenOut;
      params.fee || 100, // uint24 fee;
      recipient, // address recipient;
      params.deadline || (await helpers.time.latest()) + 3600, // uint256 deadline;
      amountOut, // uint256 amountOut;
      amountInMaximum, // uint256 amountInMaximum;
      params.sqrtPriceLimitX96 || 0, // uint160 sqrtPriceLimitX96;
    ];
  }
});

async function swapRouterMockFixture() {
  const { fpa, gelato, guardian, currency, admin, cust, rm, oracle, marketMaker, signers } = await helpers.loadFixture(
    forwardPayoutAutomationFixture
  );

  const SwapRouterMock = await ethers.getContractFactory("SwapRouterMock");
  const swapRouter = await SwapRouterMock.deploy(admin.address, currency.address);
  await swapRouter.deployed();
  await grantRole(hre, swapRouter.connect(admin), "GUARDIAN_ROLE", guardian);
  await swapRouter.connect(guardian).setOracle(ADDRESSES.WMATIC, oracle.address);

  // Deposit some WMATIC in the swap router
  await helpers.setBalance(marketMaker.address, _W(10000));
  const wmatic = await ethers.getContractAt("IWETH9", ADDRESSES.WMATIC);
  await wmatic.connect(marketMaker).deposit({ value: _W(1000) });
  await wmatic.connect(marketMaker).transfer(swapRouter.address, _W(1000));

  // Deposit some USDC in the swap router
  await currency.connect(marketMaker).transfer(swapRouter.address, _A(20000));

  return {
    fpa,
    gelato,
    guardian,
    currency,
    admin,
    cust,
    rm,
    oracle,
    marketMaker,
    signers,
    SwapRouterMock,
    swapRouter,
    wmatic,
  };
}

async function forwardPayoutAutomationFixture() {
  await setupChain(48475972);

  const [owner, lp, cust, gelato, admin, guardian, marketMaker, ...signers] = await ethers.getSigners();

  const currency = await initForkCurrency(
    ADDRESSES.USDC,
    ADDRESSES.USDCWhale,
    [lp, cust, marketMaker],
    [_A("8000"), _A("500"), _A("100000")]
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

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const swap = await SwapLibrary.deploy();
  // feeTier and Swap Router
  const swapDefaultParams = ethers.utils.defaultAbiCoder.encode(
    ["uint24", "address"],
    [_A("0.0005"), ADDRESSES.SwapRouter]
  );

  const ForwardPayoutAutomation = await ethers.getContractFactory("ForwardPayoutAutomation", {
    libraries: {
      SwapLibrary: swap.address,
    },
  });
  const fpa = await hre.upgrades.deployProxy(
    ForwardPayoutAutomation,
    ["The Name", "SYMB", admin.address, oracle.address, [1, _W("0.02"), swapDefaultParams]],
    {
      kind: "uups",
      constructorArgs: [pool.address, automate.address, ADDRESSES.WMATIC],
      unsafeAllowLinkedLibraries: true,
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
    marketMaker,
    oracle,
    owner,
    pool,
    premiumsAccount,
    PriceOracleMock,
    PriceRiskModule,
    rm,
    signers,
    srEtk,
    swapDefaultParams,
    SwapLibrary,
    swap,
  };
}
