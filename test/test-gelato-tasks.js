const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { MaxUint256, ZeroAddress } = ethers;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { Protocols, buildUniswapConfig } = require("@ensuro/swaplibrary/js/utils");

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
  USDCWhale: "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245", // Random account with lot of USDC
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
  return BigInt(contract.interface.getFunction(signature).selector) << BigInt(256 - 32);
}

hre.upgrades.silenceWarnings();

describe("Test Gelato Task Creation / Execution", function () {
  it("ForwardPayoutAutomation can be constructed with policy pool and gelato's address", async () => {
    const { pool, ForwardPayoutAutomation, automate } = await helpers.loadFixture(forwardPayoutAutomationFixture);
    await expect(ForwardPayoutAutomation.deploy(pool, automate, ADDRESSES.WMATIC)).not.to.be.reverted;

    await expect(ForwardPayoutAutomation.deploy(pool, automate, ZeroAddress)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: WETH address cannot be zero"
    );
  });

  it("Should never allow reinitialization", async () => {
    const { fpa, lp, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    const swapConfig = buildUniswapConfig(_W(0), _A("0.0005"), ADDRESSES.SwapRouter);
    await expect(fpa.initialize("Another Name", "SYMB", lp, oracle, swapConfig)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
  });

  it("Should check event methods are only callable by the pool", async () => {
    const { fpa, pool, lp } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await expect(fpa.connect(lp).onPayoutReceived(pool, lp, 1, 0)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );

    await expect(fpa.connect(lp).onPolicyExpired(pool, lp, 12)).to.be.revertedWith(
      "PayoutAutomationBase: The caller must be the PolicyPool"
    );
  });

  it("Requires all parameters on initialization", async () => {
    const { pool, ForwardPayoutAutomation, automate, oracle, admin } =
      await helpers.loadFixture(forwardPayoutAutomationFixture);

    const fpa = await ForwardPayoutAutomation.deploy(pool, automate, ADDRESSES.WMATIC);
    await fpa.waitForDeployment();

    let swapConfig = buildUniswapConfig(_W(0), _A("0.0005"), ADDRESSES.SwapRouter);
    await expect(fpa.initialize("The Name", "SYMB", admin, oracle, swapConfig)).to.be.revertedWith(
      "SwapLibrary: maxSlippage cannot be zero"
    );

    swapConfig = buildUniswapConfig(_W("0.02"), _A("0.0005"), ADDRESSES.SwapRouter);
    await expect(fpa.initialize("The Name", "SYMB", admin, ZeroAddress, swapConfig)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: oracle address cannot be zero"
    );

    swapConfig = buildUniswapConfig(_W("0.02"), _A("0.0005"), ZeroAddress);
    await expect(fpa.initialize("The Name", "SYMB", admin, oracle, swapConfig)).to.be.revertedWith(
      "SwapLibrary: SwapRouter address cannot be zero"
    );

    swapConfig = buildUniswapConfig(_W("0.02"), _A(0), ADDRESSES.SwapRouter);
    await expect(fpa.initialize("The Name", "SYMB", admin, oracle, swapConfig)).to.be.revertedWith(
      "SwapLibrary: feeTier cannot be zero"
    );

    swapConfig = buildUniswapConfig(_W("0.02"), _A("0.0005"), ADDRESSES.SwapRouter);
    let swapCustomParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint24", "address"],
      [_A("0.0005"), ADDRESSES.SwapRouter]
    );
    await expect(fpa.initialize("The Name", "SYMB", admin, oracle, swapConfig))
      .to.emit(fpa, "OracleSet")
      .withArgs(oracle)
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([Protocols.uniswap, _W("0.02"), swapCustomParams]);
  });

  it("Allows setting oracle", async () => {
    const { fpa, oracle, lp, signers, oracleAdmin } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    expect(await fpa.oracle()).to.equal(oracle);
    await expect(fpa.connect(lp).setOracle(ZeroAddress)).to.be.revertedWith(
      accessControlMessage(lp, null, "SET_ORACLE_ROLE")
    );

    await expect(fpa.connect(oracleAdmin).setOracle(ZeroAddress)).to.be.revertedWith(
      "PayoutAutomationBaseGelato: oracle address cannot be zero"
    );
    await expect(fpa.connect(oracleAdmin).setOracle(signers[1]) /* some random address */)
      .to.emit(fpa, "OracleSet")
      .withArgs(signers[1]);
    expect(await fpa.oracle()).to.equal(signers[1]);
  });

  it("Only SWAP_CONFIG_ROLE can set swap config", async () => {
    const { fpa, swapConfigAdmin, lp, signers } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    const swapConfig = buildUniswapConfig(_W("0.1"), _A("0.0005"), ADDRESSES.SwapRouter);
    await expect(fpa.connect(lp).setSwapConfig(swapConfig)).to.be.revertedWith(
      accessControlMessage(lp, null, "SET_SWAP_CONFIG_ROLE")
    );
    // some random address as router
    const signerAddr = await ethers.resolveAddress(signers[1]);
    let randomAddr = ethers.AbiCoder.defaultAbiCoder().encode(["uint24", "address"], [_A("0.0005"), signerAddr]);
    await expect(fpa.connect(swapConfigAdmin).setSwapConfig([Protocols.uniswap, _W("0.07"), randomAddr]))
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([Protocols.uniswap, _W("0.07"), randomAddr]);
  });

  it("Only SET_ORACLE_ROLE can set oracle and SET_SWAP_CONFIG_ROLE can set swap config", async () => {
    const { fpa, swapConfigAdmin, oracleAdmin, lp, signers } =
      await helpers.loadFixture(forwardPayoutAutomationFixture);

    const swapConfig = buildUniswapConfig(_W("0.1"), _A("0.0005"), ADDRESSES.SwapRouter);
    await expect(fpa.connect(lp).setSwapConfig(swapConfig)).to.be.revertedWith(
      accessControlMessage(lp, null, "SET_SWAP_CONFIG_ROLE")
    );

    await expect(fpa.connect(lp).setOracle(ZeroAddress)).to.be.revertedWith(
      accessControlMessage(lp, null, "SET_ORACLE_ROLE")
    );

    // some random address as router
    const signerAddr = await ethers.resolveAddress(signers[1]);
    let randomAddr = ethers.AbiCoder.defaultAbiCoder().encode(["uint24", "address"], [_A("0.0005"), signerAddr]);
    await expect(fpa.connect(swapConfigAdmin).setSwapConfig([Protocols.uniswap, _W("0.07"), randomAddr]))
      .to.emit(fpa, "SwapConfigSet")
      .withArgs([Protocols.uniswap, _W("0.07"), randomAddr]);

    await expect(fpa.connect(oracleAdmin).setOracle(signers[1])).to.emit(fpa, "OracleSet").withArgs(signerAddr);
    expect(await fpa.oracle()).to.equal(signerAddr);
  });

  it("Allows setting swap config", async () => {
    const { fpa, lp, swapConfigAdmin, signers } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    let swapConfigParams = buildUniswapConfig(_W("0.05"), _A("0.0005"), ADDRESSES.SwapRouter);

    let swapConfig = await fpa.swapConfig();
    const swapDefaultParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint24", "address"],
      [_A("0.0005"), ADDRESSES.SwapRouter]
    );
    expect(swapConfig.protocol).to.equal(1);
    expect(swapConfig.maxSlippage).to.equal(_W("0.02"));
    expect(swapConfig.customParams).to.equal(swapDefaultParams);
    await expect(fpa.connect(lp).setSwapConfig(swapConfigParams)).to.be.revertedWith(
      accessControlMessage(lp, null, "SET_SWAP_CONFIG_ROLE")
    );

    swapConfigParams = buildUniswapConfig(_W("0.02"), _A("0.0005"), ZeroAddress);
    await expect(fpa.connect(swapConfigAdmin).setSwapConfig(swapConfigParams)).to.be.revertedWith(
      "SwapLibrary: SwapRouter address cannot be zero"
    );

    await expect(fpa.connect(swapConfigAdmin).setSwapConfig([3, _W("0.04"), swapDefaultParams])).to.be.reverted;

    await expect(
      fpa.connect(swapConfigAdmin).setSwapConfig([Protocols.undefined, _W("0.04"), swapDefaultParams])
    ).to.be.revertedWith("SwapLibrary: invalid protocol");

    // some random address as router
    const signerAddr = await ethers.resolveAddress(signers[1]);
    swapConfigParams = buildUniswapConfig(_W("0.06"), _A("0.0005"), signerAddr);
    await expect(fpa.connect(swapConfigAdmin).setSwapConfig(swapConfigParams))
      .to.emit(fpa, "SwapConfigSet")
      .withArgs(swapConfigParams);

    swapConfig = await fpa.swapConfig();
    expect(swapConfig.protocol).to.equal(1);
    expect(swapConfig.maxSlippage).to.equal(_W("0.06"));
    let randomAddr = ethers.AbiCoder.defaultAbiCoder().encode(["uint24", "address"], [_A("0.0005"), signerAddr]);
    expect(swapConfig.customParams).to.equal(randomAddr);
  });

  it("Creates a policy resolution task when a policy is created", async () => {
    const { fpa, automate, rm, cust, currency, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await currency.connect(cust).approve(fpa, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy
    const tx = await fpa.connect(cust).newPolicy(rm, _W("0.6"), true, _A(1000), start + HOUR * 24, cust);

    // A task was created
    const triggerPolicySelector = rightPaddedFunctionSelector(rm, "triggerPolicy(uint256)");
    await expect(tx)
      .to.emit(automate, "TaskCreated")
      .withArgs(anyValue, rm, triggerPolicySelector, anyValue, ADDRESSES.ETH);

    // Workaround broken struct match - https://github.com/NomicFoundation/hardhat/issues/3833
    const receipt = await tx.wait();
    const event = await getTransactionEvent(automate.interface, receipt, "TaskCreated");

    const resolverArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [fpa.target, fpa.interface.encodeFunctionData("checker", [rm.target, makePolicyId(rm.target, 1)])]
    );
    expect(event.args[3]).to.deep.equal([[Module.RESOLVER], [resolverArgs]]);

    // The check for the task returns canExec = False
    const [canExec] = await fpa.checker(rm, makePolicyId(rm, 1));
    expect(canExec).to.be.false;

    // When the price drops the check still returns canExec = False because minDuration has not elapsed
    await oracle.setPrice(_E("0.59"));
    const [canExec2] = await fpa.checker(rm, makePolicyId(rm, 1));
    expect(canExec2).to.be.false;

    // After minDuration elapses it returns true
    await helpers.time.increase(HOUR);
    const [canExec3] = await fpa.checker(rm, makePolicyId(rm, 1));
    expect(canExec3).to.be.true;
  });

  it("Pays for gelato tx fee when resolving policies", async () => {
    const { pool, fpa, rm, cust, currency, oracle, gelato, automate } =
      await helpers.loadFixture(forwardPayoutAutomationFixture);

    await currency.connect(cust).approve(fpa, _A(2000));

    const start = await helpers.time.latest();

    // Initial price is 0.62 USDC per MATIC
    await oracle.setPrice(_W("0.62"));

    // Create a new policy that triggers under $0.57
    const creationTx = await fpa.connect(cust).newPolicy(rm, _W("0.57"), true, _A(1000), start + HOUR * 24, cust);
    const taskCreatedEvent = await getTransactionEvent(automate.interface, await creationTx.wait(), "TaskCreated");

    // Price drops below trigger price
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));

    // Task can now be executed
    const [canExec, payload] = await fpa.checker(rm, makePolicyId(rm, 1));
    expect(canExec).to.be.true;

    // Gelato triggers the policy
    const tx = await gelato.sendTransaction({ to: rm, data: payload });

    // Sanity check
    await expect(tx).to.emit(pool, "PolicyResolved").withArgs(rm, makePolicyId(rm, 1), _A(1000));

    // The fee was paid to gelato
    await expect(tx).to.changeEtherBalance(gelato, _W("0.013371337"));

    // The rest of the payout was transferred to the policy holder
    await expect(tx).to.changeTokenBalance(currency, cust, _A("999.992491") /* $1000 payout - $0.007509 fee */);

    // The task was removed from gelato
    await expect(tx).to.emit(automate, "TaskCancelled").withArgs(taskCreatedEvent.args.taskId, fpa);
  });

  it("Removes task on expiration", async () => {
    const { pool, fpa, rm, cust, currency, automate } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    await currency.connect(cust).approve(fpa, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy that expires in 24 hours
    const creationTx = await fpa.connect(cust).newPolicy(rm, _W("0.57"), true, _A(1000), start + HOUR * 24, cust);
    const taskCreatedEvent = await getTransactionEvent(automate.interface, await creationTx.wait(), "TaskCreated");

    // Policy expires
    await helpers.time.increase(HOUR * 24);
    const policy = (await rm.getPolicyData(makePolicyId(rm, 1)))[0];
    const tx = await pool.expirePolicy([...policy]);

    // The task has been cancelled
    await expect(tx).to.emit(automate, "TaskCancelled").withArgs(taskCreatedEvent.args.taskId, fpa);

    // No funds were transferred to or from the customer
    await expect(tx).to.changeTokenBalance(currency, cust, 0);

    // No funds were transferred to or from the payout automation contract
    await expect(tx).to.changeTokenBalance(currency, fpa, 0);
    await expect(tx).to.changeEtherBalance(fpa, 0);
  });

  it("Gives 0 allowance to the swap router on initialization", async () => {
    const { fpa, currency, cust, rm, oracle } = await helpers.loadFixture(forwardPayoutAutomationFixture);

    // Initialized contract has 0 allowance on the router
    expect(await currency.allowance(fpa, ADDRESSES.SwapRouter)).to.equal(0);

    // Creating / resolving policies does not change allowance
    const start = await helpers.time.latest();
    await currency.connect(cust).approve(fpa, _A(2000));
    await fpa.connect(cust).newPolicy(rm, _W("0.57"), true, _A(1000), start + HOUR * 24, cust);
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));
    await rm.triggerPolicy(makePolicyId(rm, 1));

    // After trigger the policy, the allowance should be 0 again
    expect(await currency.allowance(fpa, ADDRESSES.SwapRouter)).to.equal(0);
  });
});

describe("SwapRouterMock", () => {
  it("Works with payout automation", async () => {
    const { fpa, gelato, swapConfigAdmin, currency, admin, cust, rm, oracle, swapRouter, wmatic } =
      await helpers.loadFixture(swapRouterMockFixture);
    // Allow the payout automation contract to perform swaps
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", fpa);

    // Use the mock swapRouter in the payout automation
    const swapRouterAddr = await ethers.resolveAddress(swapRouter);
    const swapConfig = buildUniswapConfig(_W("0.05"), _A("0.0005"), swapRouterAddr);
    await fpa.connect(swapConfigAdmin).setSwapConfig(swapConfig);
    await fpa.connect(swapConfigAdmin).setSwapConfig(swapConfig);

    // Create and trigger a policy
    const start = await helpers.time.latest();
    await oracle.setPrice(_W("0.62"));
    await currency.connect(cust).approve(fpa, _A(2000));
    await fpa.connect(cust).newPolicy(rm, _W("0.57"), true, _A(1000), start + HOUR * 24, cust);
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));
    const tx = await rm.triggerPolicy(makePolicyId(rm, 1));

    // After trigger the policy, the allowance should be 0 again
    expect(await currency.allowance(fpa, ADDRESSES.SwapRouter)).to.equal(0);

    // The exchange was made using the swap router funds
    await expect(tx).to.changeEtherBalance(gelato, _W("0.013371337")); // sanity check that the fee was paid
    await expect(tx).to.changeTokenBalance(wmatic, swapRouter, _W("-0.013371337"));
    await expect(tx).to.changeTokenBalance(currency, swapRouter, _A("0.007474") /* $0.007474 fee */);
  });

  it("Only allows withdrawing funds to guardian", async () => {
    const { guardian, currency, signers, swapRouter, wmatic } = await helpers.loadFixture(swapRouterMockFixture);

    expect(await swapRouter.hasRole(getRole("GUARDIAN_ROLE"), signers[1])).to.be.false;
    await expect(swapRouter.connect(signers[1]).withdraw(ADDRESSES.ETH, _W(1))).to.be.revertedWith(
      accessControlMessage(signers[1], null, "GUARDIAN_ROLE")
    );
    await expect(swapRouter.connect(signers[1]).withdraw(currency, _A(100))).to.be.revertedWith(
      accessControlMessage(signers[1], null, "GUARDIAN_ROLE")
    );

    await expect(swapRouter.connect(guardian).withdraw(wmatic, _W(1))).to.changeTokenBalance(wmatic, guardian, _W(1));
    await expect(swapRouter.connect(guardian).withdraw(currency, _A(100))).to.changeTokenBalance(
      currency,
      guardian,
      _A(100)
    );
  });

  it("Can do exactInputSingle swaps", async () => {
    const { currency, admin, oracle, marketMaker, swapRouter, wmatic } =
      await helpers.loadFixture(swapRouterMockFixture);

    const swapExactInputParams = [
      currency, // address tokenIn;
      wmatic, // address tokenOut;
      100, // uint24 fee;
      marketMaker, // address recipient;
      (await helpers.time.latest()) + 3600, // uint256 deadline;
      _A("10"), // uint256 amountIn;
      _W("15"), // uint256 amountOutMinimum;
      0, // uint160 sqrtPriceLimitX96;
    ];
    await expect(swapRouter.connect(marketMaker).exactInputSingle(swapExactInputParams)).to.be.revertedWith(
      accessControlMessage(marketMaker, null, "SWAP_ROLE")
    );
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", marketMaker);
    await currency.connect(marketMaker).approve(swapRouter, _A(10));
    await oracle.setPrice(_W("0.64"));
    const swapTx = await swapRouter.connect(marketMaker).exactInputSingle(swapExactInputParams);
    await expect(swapTx).to.changeTokenBalance(currency, marketMaker, _A("-10"));
    await expect(swapTx).to.changeTokenBalance(wmatic, marketMaker, _W("15.625"));
  });

  it("Supports a configurable slippage", async () => {
    const { guardian, currency, admin, cust, oracle, marketMaker, swapRouter, wmatic } =
      await helpers.loadFixture(swapRouterMockFixture);
    expect(await swapRouter.slippage()).to.equal(_W("1"));
    await expect(swapRouter.connect(cust).setSlippage(_W("0.01"))).to.be.revertedWith(
      accessControlMessage(cust, null, "GUARDIAN_ROLE")
    );
    await expect(swapRouter.connect(guardian).setSlippage(_W("1.02")))
      .to.emit(swapRouter, "SlippageUpdated")
      .withArgs(_W("1.02"));

    await oracle.setPrice(_W("0.62")); // 1 MATIC = $0.62 + 2% = $0.6324.
    await grantRole(hre, swapRouter.connect(admin), "SWAP_ROLE", marketMaker);
    await currency.connect(marketMaker).approve(swapRouter, _A(10));

    let swapExactOutputParams = await makeExactOutputParams(marketMaker, _W("1"), _A("0.63"));
    await expect(swapRouter.connect(marketMaker).exactOutputSingle(swapExactOutputParams)).to.be.revertedWith(
      "amountInMaximum exceeded"
    );

    swapExactOutputParams = await makeExactOutputParams(marketMaker, _W("1"), _A("0.6324"));
    const swapOutputTx = await swapRouter.connect(marketMaker).exactOutputSingle(swapExactOutputParams);
    await expect(swapOutputTx).to.changeTokenBalance(currency, marketMaker, _A("-0.6324"));
    await expect(swapOutputTx).to.changeTokenBalance(wmatic, marketMaker, _W("1"));

    const swapExactInputParams = [
      currency, // address tokenIn;
      wmatic, // address tokenOut;
      100, // uint24 fee;
      marketMaker, // address recipient;
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
  const { fpa, gelato, guardian, swapConfigAdmin, currency, admin, cust, rm, oracle, marketMaker, signers } =
    await helpers.loadFixture(forwardPayoutAutomationFixture);

  const SwapRouterMock = await ethers.getContractFactory("SwapRouterMock");
  const swapRouter = await SwapRouterMock.deploy(admin, currency);
  await swapRouter.waitForDeployment();
  await grantRole(hre, swapRouter.connect(admin), "GUARDIAN_ROLE", guardian);
  await swapRouter.connect(guardian).setOracle(ADDRESSES.WMATIC, oracle);

  // Deposit some WMATIC in the swap router
  const marketMakerAddr = await ethers.resolveAddress(marketMaker);
  await helpers.setBalance(marketMakerAddr, _W(10000));
  const wmatic = await ethers.getContractAt("IWETH9", ADDRESSES.WMATIC);
  await wmatic.connect(marketMaker).deposit({ value: _W(1000) });
  await wmatic.connect(marketMaker).transfer(swapRouter, _W(1000));

  // Deposit some USDC in the swap router
  await currency.connect(marketMaker).transfer(swapRouter, _A(20000));

  return {
    fpa,
    gelato,
    guardian,
    swapConfigAdmin,
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

  const [owner, lp, cust, gelato, admin, guardian, oracleAdmin, swapConfigAdmin, marketMaker, ...signers] =
    await ethers.getSigners();

  const currency = await initForkCurrency(
    ADDRESSES.USDC,
    ADDRESSES.USDCWhale,
    [lp, cust, marketMaker],
    [_A("8000"), _A("500"), _A("100000")]
  );

  const pool = await deployPool({
    currency: currency,
    grantRoles: ["LEVEL1_ROLE", "LEVEL2_ROLE"],
    treasuryAddress: "0x87c47c9a5a2aa74ae714857d64911d9a091c25b1", // Random address
  });
  pool._A = _A;
  const poolAddr = await ethers.resolveAddress(pool);

  const srEtk = await addEToken(pool, {});
  const jrEtk = await addEToken(pool, {});

  const premiumsAccount = await deployPremiumsAccount(pool, { srEtk: srEtk, jrEtk: jrEtk });

  const accessManager = await ethers.getContractAt("AccessManager", await pool.access());

  await currency.connect(lp).approve(pool, MaxUint256);
  await currency.connect(cust).approve(pool, MaxUint256);
  await pool.connect(lp).deposit(srEtk, _A("5000"));
  await pool.connect(lp).deposit(jrEtk, _A("3000"));

  const PriceOracleMock = await ethers.getContractFactory("PriceOracleMock");
  const oracle = await PriceOracleMock.deploy(_W("0.62"));
  const oracleAddr = await ethers.resolveAddress(oracle);

  const PriceRiskModule = await ethers.getContractFactory("PriceRiskModule");
  const rm = await addRiskModule(pool, premiumsAccount, PriceRiskModule, {
    extraConstructorArgs: [_W("0.01")],
    extraArgs: [oracleAddr],
  });

  await grantComponentRole(hre, accessManager, rm, "PRICER_ROLE", owner);

  const newCdf = Array(Number(await rm.PRICE_SLOTS())).fill([_W("0.01"), _W("0.05"), _W("1.0")]);
  await rm.setCDF(24, newCdf);

  const AutomateMock = await ethers.getContractFactory("AutomateMock");
  const automate = await AutomateMock.deploy(gelato);
  const automateAddr = await ethers.resolveAddress(automate);

  const SwapLibrary = await ethers.getContractFactory("SwapLibrary");
  const deployedSwapLibrary = await SwapLibrary.deploy();
  const swapAddr = await ethers.resolveAddress(deployedSwapLibrary);

  const ForwardPayoutAutomation = await ethers.getContractFactory("ForwardPayoutAutomation", {
    libraries: { SwapLibrary: swapAddr },
  });
  const adminAddr = await ethers.resolveAddress(admin);

  const swapConfig = buildUniswapConfig(_W("0.02"), _A("0.0005"), ADDRESSES.SwapRouter);
  const fpa = await hre.upgrades.deployProxy(
    ForwardPayoutAutomation,
    ["The Name", "SYMB", adminAddr, oracleAddr, swapConfig],
    {
      kind: "uups",
      constructorArgs: [poolAddr, automateAddr, ADDRESSES.WMATIC],
      unsafeAllowLinkedLibraries: true,
    }
  );

  await grantRole(hre, fpa.connect(admin), "GUARDIAN_ROLE", guardian);
  await grantRole(hre, fpa.connect(admin), "SET_SWAP_CONFIG_ROLE", swapConfigAdmin);
  await grantRole(hre, fpa.connect(admin), "SET_ORACLE_ROLE", oracleAdmin);

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
    swapConfigAdmin,
    oracleAdmin,
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
    SwapLibrary,
    deployedSwapLibrary,
  };
}
