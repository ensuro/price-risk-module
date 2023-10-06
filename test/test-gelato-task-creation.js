const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { MaxUint256 } = ethers.constants;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const {
  _W,
  _E,
  amountFunction,
  grantComponentRole,
  makePolicyId,
  getTransactionEvent,
} = require("@ensuro/core/js/utils");
const {
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  addEToken,
  initCurrency,
} = require("@ensuro/core/js/test-utils");

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);

const GELATO_OPS_PROXY_DEPLOYER = "0x5401fe33559a355638b9b37c9640a04a182feff2";
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// enum
const Module = {
  RESOLVER: 0,
  TIME: 1,
  PROXY: 2,
  SINGLE_EXEC: 3,
};

const HOUR = 3600;

function rightPaddedFunctionSelector(contract, signature) {
  return ethers.BigNumber.from(contract.interface.getSighash(signature)).shl(256 - 32);
}

hre.upgrades.silenceWarnings();

describe("Test Gelato Task Creation / Execution", function () {
  it("ForwardPayoutAutomationGelato can be constructed with policy pool and gelato's address", async () => {
    const { pool, ForwardPayoutAutomationGelato, automate } = await helpers.loadFixture(deployPoolFixture);
    await expect(ForwardPayoutAutomationGelato.deploy(pool.address, automate.address)).not.to.be.reverted;
  });

  it("Creates a policy resolution task when a policy is created", async () => {
    const { pool, ForwardPayoutAutomationGelato, automate, rm, lp, cust, currency, oracle } = await helpers.loadFixture(
      deployPoolFixture
    );
    const fpa = await hre.upgrades.deployProxy(ForwardPayoutAutomationGelato, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, automate.address],
    });

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy
    const tx = await fpa.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address);

    // A task was created
    const triggerPolicySelector = rightPaddedFunctionSelector(rm, "triggerPolicy(uint256)");
    await expect(tx).to.emit(automate, "TaskCreated").withArgs(rm.address, triggerPolicySelector, anyValue, ETH);

    // Workaround broken struct match - https://github.com/NomicFoundation/hardhat/issues/3833
    const receipt = await tx.wait();
    const event = await getTransactionEvent(automate.interface, receipt, "TaskCreated");
    const resolverArgs = ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes"],
      [fpa.address, fpa.interface.encodeFunctionData("checker", [rm.address, makePolicyId(rm.address, 1)])]
    );
    expect(event.args[2]).to.deep.equal([[Module.RESOLVER], [resolverArgs]]);

    // The check for the task returns canExec = False
    const [canExec] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec).to.be.false;

    // When the price drops the check still returns canExec = False because minDuration has not elapsed
    await oracle.setPrice(_E("1390"));
    const [canExec2] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec2).to.be.false;

    // After minDuration elapses it returns true
    await helpers.time.increase(HOUR);
    const [canExec3] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec3).to.be.true;
  });

  it("Pays for gelato tx fee when resolving policies", async () => {
    const { pool, ForwardPayoutAutomationGelato, automate, rm, lp, cust, currency, oracle, gelato } =
      await helpers.loadFixture(deployPoolFixture);
    const fpa = await hre.upgrades.deployProxy(ForwardPayoutAutomationGelato, ["The Name", "SYMB", lp.address], {
      kind: "uups",
      constructorArgs: [pool.address, automate.address],
    });
    // temporary hack, to be removed once swap is implemented
    await helpers.setBalance(fpa.address, _W("1000"));

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Create a new policy
    await fpa.connect(cust).newPolicy(rm.address, _W(1400), true, _A(1000), start + HOUR * 24, cust.address);

    // Price drops below trigger price
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_E("1390"));
    const [canExec] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec).to.be.true;

    // Gelato triggers the policy
    const tx = await rm.triggerPolicy(makePolicyId(rm.address, 1));

    // The fee was paid to gelato
    await expect(tx).to.changeEtherBalance(gelato, _W("0.000001337"));

    // TODO: Task should be cancelled after this
  });
});

// TODO: task cancelation on expiration

async function deployPoolFixture() {
  // Why isn't hardhat doing this automatically??
  await hre.network.provider.request({
    method: "hardhat_reset",
  });

  const [owner, lp, cust, gelato, ...signers] = await ethers.getSigners();

  const currency = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: CURRENCY_DECIMALS, initial_supply: _A("10000") },
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

  await currency.connect(lp).approve(pool.address, MaxUint256);
  await currency.connect(cust).approve(pool.address, MaxUint256);
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

  // The OPS proxy factory doesn't really matter to us because we're not using dedicated msg sender
  // But it needs to be in this specific address because it's hardcoded in gelato's AutomateReady.sol
  await helpers.impersonateAccount(GELATO_OPS_PROXY_DEPLOYER);
  await helpers.setNonce(GELATO_OPS_PROXY_DEPLOYER, "0x2");
  await helpers.setBalance(GELATO_OPS_PROXY_DEPLOYER, _W("10"));
  const gelatoOpsProxyFactoryDeployer = await ethers.getSigner(GELATO_OPS_PROXY_DEPLOYER);
  const OpsProxyFactoryMock = await ethers.getContractFactory("OpsProxyFactoryMock");
  const opsProxyFactory = await OpsProxyFactoryMock.connect(gelatoOpsProxyFactoryDeployer).deploy({ nonce: 2 });
  expect(opsProxyFactory.address).to.equal("0xC815dB16D4be6ddf2685C201937905aBf338F5D7");

  const AutomateMock = await ethers.getContractFactory("AutomateMock");
  const automate = await AutomateMock.deploy(gelato.address);

  const ForwardPayoutAutomationGelato = await ethers.getContractFactory("ForwardPayoutAutomationGelato");

  return {
    accessManager,
    automate,
    AutomateMock,
    currency,
    cust,
    ForwardPayoutAutomationGelato,
    gelato,
    jrEtk,
    lp,
    opsProxyFactory,
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
