// Constant-product AMM math. BigInt functions round exactly like MiniPair.sol / Uniswap V2,
// so the browser's predictions can be checked against the contract to the last wei.

export const FEE_BPS = 30n;

/** out = in*(1-fee)*R_out / (R_in + in*(1-fee)), integer division like Solidity. */
export function getAmountOut(amountIn, rIn, rOut, feeBps = FEE_BPS) {
  if (amountIn <= 0n) return 0n;
  const inFee = amountIn * (10_000n - feeBps);
  return (inFee * rOut) / (rIn * 10_000n + inFee);
}

/**
 * Sandwich a victim who sells `victimIn` of token A for token B with a floor of `victimMinOut`.
 * The attacker buys B first (front-run), the victim fills at a worse price, the attacker sells B back.
 * Returns the attacker's best front-run size, profit (in token A, before gas) and the victim's loss.
 */
export function sandwich({ rA, rB, victimIn, victimMinOut, feeBps = FEE_BPS, samples = 64 }) {
  const fair = getAmountOut(victimIn, rA, rB, feeBps);
  const run = x => {
    const got = getAmountOut(x, rA, rB, feeBps); // attacker's front-run: A -> B
    let a = rA + x, b = rB - got;
    const vOut = getAmountOut(victimIn, a, b, feeBps); // victim's trade
    if (vOut < victimMinOut) return null; // victim reverts, sandwich fails
    a += victimIn; b -= vOut;
    const back = getAmountOut(got, b, a, feeBps); // back-run: B -> A
    return { x, got, vOut, back, profit: back - x };
  };
  if (!run(0n)) return { feasible: false, fair, reason: 'Victim fails even with no front-run.' };
  // largest front-run the victim's slippage limit allows (output falls as x grows)
  let lo = 0n, hi = rA * 4n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; run(mid) ? (lo = mid) : (hi = mid); }
  const xMax = lo;
  // profit is unimodal in x, so a ternary search inside [0, xMax] finds the best size
  let a = 0n, b = xMax;
  while (b - a > 2n) {
    const m1 = a + (b - a) / 3n, m2 = b - (b - a) / 3n;
    run(m1).profit < run(m2).profit ? (a = m1) : (b = m2);
  }
  let best = run(a);
  for (let x = a; x <= b; x++) { const r = run(x); if (r.profit > best.profit) best = r; }
  const curve = [];
  for (let i = 0; i <= samples; i++) { const x = (xMax * BigInt(i)) / BigInt(samples); const r = run(x); curve.push([x, r.profit]); }
  return { feasible: true, fair, xMax, best, victimLoss: fair - best.vOut, curve };
}

// ---------- float helpers for the UI ----------
/** Impermanent loss at price ratio r = P_now / P_entry, as a fraction (negative = loss vs holding). */
export const impermanentLoss = r => (2 * Math.sqrt(r)) / (1 + r) - 1;

/** Spot price of A in B, and the execution price and impact of a trade. */
export function quote(amountIn, rIn, rOut, feeBps = 30) {
  const g = 1 - feeBps / 1e4;
  const out = (amountIn * g * rOut) / (rIn + amountIn * g);
  const spot = rOut / rIn;
  return { out, spot, exec: out / amountIn, impact: 1 - out / amountIn / spot };
}

/**
 * Arbitrage the pool to an external price P (token1 per token0).
 * With fee multiplier g, the profit-maximising input closes the gap to within the fee band:
 *   buy token0:  dy = (sqrt(g * x * y * P) - y) / g
 *   sell token0: dx = (sqrt(g * x * y / P) - x) / g
 */
export function arbitrage(x, y, P, feeBps = 30) {
  const g = 1 - feeBps / 1e4;
  const spot = y / x;
  if (spot * (1 / g) < P) { // token0 cheap in pool: pay token1, receive token0
    const dy = (Math.sqrt(g * x * y * P) - y) / g;
    if (dy <= 0) return null;
    const dx = (dy * g * x) / (y + dy * g);
    return { side: 'buy0', in: dy, out: dx, profit: dx * P - dy, newPrice: (y + dy) / (x - dx) };
  }
  if (spot * g > P) { // token0 expensive in pool: sell token0
    const dx = (Math.sqrt((g * x * y) / P) - x) / g;
    if (dx <= 0) return null;
    const dy = (dx * g * y) / (x + dx * g);
    return { side: 'sell0', in: dx, out: dy, profit: dy - dx * P, newPrice: (y - dy) / (x + dx) };
  }
  return null; // inside the no-arbitrage band set by the fee
}
