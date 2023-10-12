const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { MaxUint256 } = ethers.constants;
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { fork } = require("./utils");

const {
  _W,
  _E,
  amountFunction,
  grantComponentRole,
  makePolicyId,
  getTransactionEvent,
} = require("@ensuro/core/js/utils");
const { deployPool, deployPremiumsAccount, addRiskModule, addEToken } = require("@ensuro/core/js/test-utils");

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);

const ADDRESSES = {
  // polygon mainnet addresses
  automate: "0x527a819db1eb0e34426297b03bae11F2f8B3A19E",
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDCWhale: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
};

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
    const fpa = await hre.upgrades.deployProxy(
      ForwardPayoutAutomationGelato,
      ["The Name", "SYMB", lp.address, oracle.address],
      {
        kind: "uups",
        constructorArgs: [pool.address, automate.address],
      }
    );

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
      .withArgs(rm.address, triggerPolicySelector, anyValue, ADDRESSES.ETH);

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
    await oracle.setPrice(_E("0.59"));
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
    const fpa = await hre.upgrades.deployProxy(
      ForwardPayoutAutomationGelato,
      ["The Name", "SYMB", lp.address, oracle.address],
      {
        kind: "uups",
        constructorArgs: [pool.address, automate.address],
      }
    );

    await currency.connect(cust).approve(fpa.address, _A(2000));

    const start = await helpers.time.latest();

    // Initial price is 0.62 USDC per MATIC
    await oracle.setPrice(_W("0.62"));

    // Create a new policy that triggers under $0.57
    await fpa.connect(cust).newPolicy(rm.address, _W("0.57"), true, _A(1000), start + HOUR * 24, cust.address);

    // Price drops below trigger price
    await helpers.time.increase(HOUR);
    await oracle.setPrice(_W("0.559"));

    // Task can now be executed
    const [canExec] = await fpa.checker(rm.address, makePolicyId(rm.address, 1));
    expect(canExec).to.be.true;

    // Gelato triggers the policy (TODO: use the checker payload for this to better simulate gelato)
    const tx = await rm.triggerPolicy(makePolicyId(rm.address, 1));

    // Sanity check
    await expect(tx).to.emit(pool, "PolicyResolved").withArgs(rm.address, makePolicyId(rm.address, 1), _A(1000));

    // The fee was paid to gelato
    await expect(tx).to.changeEtherBalance(gelato, _W("0.013371337"));

    // The rest of the payout was transferred to the policy holder
    await expect(tx).to.changeTokenBalance(currency, cust, _A("999.992491") /* $1000 payout - $0.007509 fee */);

    // TODO: Task should be cancelled after this
  });
});

// TODO: task cancelation on expiration

async function deployPoolFixture() {
  fork(48475972);

  const [owner, lp, cust, gelato, ...signers] = await ethers.getSigners();

  // TODO: integrate this into ensuro's test-utils
  const currency = await ethers.getContractAt("IERC20", ADDRESSES.USDC, owner);
  await helpers.impersonateAccount(ADDRESSES.USDCWhale);
  await helpers.setBalance(ADDRESSES.USDCWhale, ethers.utils.parseEther("100"));
  const whale = await ethers.getSigner(ADDRESSES.USDCWhale);
  await currency.connect(whale).transfer(lp.address, _A("8000"));
  await currency.connect(whale).transfer(cust.address, _A("500"));

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
