const { _W } = require("@ensuro/core/js/test-utils");

exports.addRiskModuleWithParams = async function (
  pool,
  poolAddress,
  premiumsAccount,
  paAddress,
  contractFactory,
  {
    rmName,
    scrPercentage,
    scrInterestRate,
    ensuroFee,
    maxScrPerPolicy,
    scrLimit,
    moc,
    wallet,
    extraArgs,
    extraConstructorArgs,
  }
) {
  extraArgs = extraArgs || [];
  extraConstructorArgs = extraConstructorArgs || [];
  const _A = pool._A || _W;
  const rm = await hre.upgrades.deployProxy(
    contractFactory,
    [
      rmName || "RiskModule",
      _W(scrPercentage) || _W(1),
      _W(ensuroFee) || _W(0),
      _W(scrInterestRate) || _W(0.1),
      _A(maxScrPerPolicy) || _A(1000),
      _A(scrLimit) || _A(1000000),
      wallet || "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", // Random address
      ...extraArgs,
    ],
    {
      kind: "uups",
      unsafeAllow: ["delegatecall"],
      constructorArgs: [poolAddress || pool.address, paAddress || premiumsAccount.address, ...extraConstructorArgs],
    }
  );

  await rm.deployed();

  if (moc !== undefined && moc != 1.0) {
    moc = _W(moc);
    await rm.setParam(0, moc);
  }
  await pool.addComponent(rm.address, 2);
  return rm;
};
