import test from 'node:test';
import assert from 'node:assert/strict';
import { getAmountOut, sandwich, impermanentLoss, quote, arbitrage } from './amm.mjs';

test('getAmountOut matches the Uniswap V2 formula', () => {
  assert.equal(getAmountOut(1000n, 1_000_000n, 1_000_000n), 996n); // 997000*1e6/(1e10+9970000) = 996.0
  assert.equal(getAmountOut(0n, 1n, 1n), 0n);
});

test('impermanent loss reference points', () => {
  assert.equal(impermanentLoss(1), 0);
  assert.ok(Math.abs(impermanentLoss(4) + 0.2) < 1e-12); // 2x price move each way = -5.7%, 4x = -20%
  assert.ok(Math.abs(impermanentLoss(0.25) + 0.2) < 1e-12);
});

test('sandwich respects the victim floor and is profitable on loose slippage', () => {
  const rA = 10_000_000n * 10n ** 6n, rB = 4_000n * 10n ** 18n; // 10M USDC / 4000 WETH
  const victimIn = 200_000n * 10n ** 6n;
  const fair = getAmountOut(victimIn, rA, rB);
  const loose = sandwich({ rA, rB, victimIn, victimMinOut: fair * 980n / 1000n }); // 2% slippage
  assert.ok(loose.feasible && loose.best.profit > 0n);
  assert.ok(loose.best.vOut >= fair * 980n / 1000n);
  const tight = sandwich({ rA, rB, victimIn, victimMinOut: fair * 999n / 1000n }); // 0.1%
  assert.ok(tight.best.profit < loose.best.profit / 10n, 'a tight limit shrinks the extractable value by an order of magnitude');
  assert.ok(tight.best.vOut >= fair * 999n / 1000n);
});

test('arbitrage closes the gap to the fee band', () => {
  const x = 4000, y = 10_000_000; // spot 2500
  const a = arbitrage(x, y, 2600);
  assert.equal(a.side, 'buy0');
  assert.ok(a.profit > 0);
  assert.ok(Math.abs(a.newPrice / 0.997 - 2600) / 2600 < 1e-4, 'marginal buy price including fee lands on P');
  assert.equal(arbitrage(x, y, 2501), null, 'inside the 0.3% band there is no trade');
  assert.ok(quote(1, x, y).impact < 0.004);
});
