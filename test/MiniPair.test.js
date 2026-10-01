const { expect } = require('chai');
const { ethers } = require('hardhat');

const U = n => ethers.parseUnits(String(n), 6); // USDC-like
const E = n => ethers.parseUnits(String(n), 18); // WETH-like
const FAR = 2n ** 40n; // deadline far in the future

describe('MiniPair', function () {
  let usdc, weth, pair, lp, alice, mev, amm;

  before(async () => { amm = await import('../lib/amm.mjs'); });

  beforeEach(async () => {
    [lp, alice, mev] = await ethers.getSigners();
    const T = await ethers.getContractFactory('TestToken');
    usdc = await T.deploy('USD Coin', 'USDC', 6);
    weth = await T.deploy('Wrapped Ether', 'WETH', 18);
    pair = await (await ethers.getContractFactory('MiniPair')).deploy(usdc, weth);
    for (const s of [lp, alice, mev]) {
      await usdc.mint(s, U(50_000_000)); await weth.mint(s, E(20_000));
      await usdc.connect(s).approve(pair, ethers.MaxUint256); await weth.connect(s).approve(pair, ethers.MaxUint256);
    }
    await pair.connect(lp).addLiquidity(U(10_000_000), E(4_000), 0, FAR); // spot 2,500 USDC per WETH
  });

  it('mints sqrt(x*y) shares on first deposit and locks the minimum', async () => {
    const expected = BigInt(Math.floor(Math.sqrt(Number(U(10_000_000) * E(4_000)))));
    const supply = await pair.totalSupply();
    expect(supply).to.be.closeTo(expected, expected / 10n ** 9n);
    expect(await pair.balanceOf('0x000000000000000000000000000000000000dEaD')).to.equal(1000n);
  });

  it('prices a swap exactly like the JavaScript model', async () => {
    const [r0, r1] = await pair.getReserves();
    const predicted = amm.getAmountOut(U(25_000), r0, r1);
    await expect(pair.connect(alice).swapExactIn(usdc, U(25_000), predicted, alice, FAR))
      .to.emit(pair, 'Swap').withArgs(alice.address, await usdc.getAddress(), U(25_000), predicted, alice.address);
  });

  it('grows k with fees, so LPs earn on round trips', async () => {
    const [a0, a1] = await pair.getReserves();
    const k0 = a0 * a1;
    const out = await pair.connect(alice).swapExactIn.staticCall(usdc, U(1_000_000), 0, alice, FAR);
    await pair.connect(alice).swapExactIn(usdc, U(1_000_000), 0, alice, FAR);
    await pair.connect(alice).swapExactIn(weth, out, 0, alice, FAR);
    const [b0, b1] = await pair.getReserves();
    expect(b0 * b1).to.be.gt(k0);
    const shares = await pair.balanceOf(lp);
    const [got0] = await pair.connect(lp).removeLiquidity.staticCall(shares, 0, 0, FAR);
    expect(got0).to.be.gt(U(10_000_000) - U(1)); // more USDC back than deposited, at the same WETH side
  });

  it('reverts when slippage exceeds the caller limit', async () => {
    const [r0, r1] = await pair.getReserves();
    const out = amm.getAmountOut(U(100_000), r0, r1);
    await expect(pair.connect(alice).swapExactIn(usdc, U(100_000), out + 1n, alice, FAR))
      .to.be.revertedWithCustomError(pair, 'InsufficientOutput');
  });

  it('rejects unknown tokens, zero input and stale deadlines', async () => {
    await expect(pair.swapExactIn(alice.address, 1, 0, alice, FAR)).to.be.revertedWithCustomError(pair, 'InvalidToken');
    await expect(pair.swapExactIn(usdc, 0, 0, alice, FAR)).to.be.revertedWithCustomError(pair, 'ZeroAmount');
    await expect(pair.swapExactIn(usdc, 1, 0, alice, 1)).to.be.revertedWithCustomError(pair, 'Expired');
  });

  describe('sandwich attack, simulated off-chain and replayed on-chain', () => {
    async function replay(slippageBps) {
      const [r0, r1] = await pair.getReserves();
      const victimIn = U(200_000);
      const fair = amm.getAmountOut(victimIn, r0, r1);
      const minOut = fair * (10_000n - slippageBps) / 10_000n;
      const plan = amm.sandwich({ rA: r0, rB: r1, victimIn, victimMinOut: minOut });

      const usdcBefore = await usdc.balanceOf(mev);
      await pair.connect(mev).swapExactIn(usdc, plan.best.x, 0, mev, FAR); // front-run
      await pair.connect(alice).swapExactIn(usdc, victimIn, minOut, alice, FAR); // victim
      await pair.connect(mev).swapExactIn(weth, plan.best.got, 0, mev, FAR); // back-run
      const profit = (await usdc.balanceOf(mev)) - usdcBefore;
      return { plan, profit, fair, minOut };
    }

    it('extracts exactly the profit the model predicts (2% slippage)', async () => {
      const { plan, profit } = await replay(200n);
      expect(profit).to.equal(plan.best.profit);
      expect(profit).to.be.gt(U(1_000));
    });

    it('a 0.1% limit cuts the extractable value by more than 10x', async () => {
      const loose = amm.sandwich({ rA: U(10_000_000), rB: E(4_000), victimIn: U(200_000), victimMinOut: amm.getAmountOut(U(200_000), U(10_000_000), E(4_000)) * 9800n / 10000n });
      const { profit } = await replay(10n);
      expect(profit * 10n).to.be.lt(loose.best.profit);
    });

    it('over-sized front-runs make the victim revert instead of overpaying', async () => {
      const [r0, r1] = await pair.getReserves();
      const victimIn = U(200_000);
      const minOut = amm.getAmountOut(victimIn, r0, r1) * 9800n / 10000n;
      const plan = amm.sandwich({ rA: r0, rB: r1, victimIn, victimMinOut: minOut });
      await pair.connect(mev).swapExactIn(usdc, plan.xMax + U(1_000), 0, mev, FAR);
      await expect(pair.connect(alice).swapExactIn(usdc, victimIn, minOut, alice, FAR))
        .to.be.revertedWithCustomError(pair, 'InsufficientOutput');
    });
  });
});
