# AMM Lab

A Uniswap-V2-style constant-product pool in Solidity, and a browser lab that runs the same math on **live mainnet reserves**.

**Live:** https://amm-lab.vercel.app

## The contract: `contracts/MiniPair.sol`

- LP shares minted at √(x·y) on first deposit, with 1,000 shares burned to stop share-price manipulation
- 0.30% swap fee retained in reserves, so k grows and LP shares appreciate
- `minOut`, `minShares` and deadline guards, OpenZeppelin `ReentrancyGuard` and `SafeERC20`, custom errors
- `assert` that k never decreases across a swap

## The lab: `index.html` + `lib/amm.mjs`

Reads `getReserves()` from Uniswap V2 pairs (USDC/WETH, WETH/USDT, DAI/WETH, PEPE/WETH) with a raw `eth_call`, decoding the ABI by hand, and prices against Binance.

1. **Price impact.** Trade path drawn on the x·y = k hyperbola.
2. **Sandwich attack.** Integer binary search for the largest front-run the victim's slippage limit allows, then a ternary search for the bot's profit-maximising size, net of gas.
3. **CEX arbitrage.** Closed-form optimal trade `(√(γ·x·y·P) − y) / γ` and the no-arbitrage band set by the fee (the LP's loss-versus-rebalancing).
4. **Impermanent loss.** `2√r / (1 + r) − 1`, LP vs hold with fee APR, break-even APR.

## Contract and model agree to the wei

`lib/amm.mjs` uses BigInt integer division exactly like Solidity. The Hardhat suite imports it, plans a sandwich off-chain, replays the three transactions against the deployed contract, and asserts the attacker's on-chain profit equals the prediction exactly.

```
MiniPair
  ✔ mints sqrt(x*y) shares on first deposit and locks the minimum
  ✔ prices a swap exactly like the JavaScript model
  ✔ grows k with fees, so LPs earn on round trips
  ✔ reverts when slippage exceeds the caller limit
  ✔ rejects unknown tokens, zero input and stale deadlines
  sandwich attack, simulated off-chain and replayed on-chain
    ✔ extracts exactly the profit the model predicts (2% slippage)
    ✔ a 0.1% limit cuts the extractable value by more than 10x
    ✔ over-sized front-runs make the victim revert instead of overpaying
```

```bash
npm install
npm test        # Hardhat (Solidity) + node:test (JS math)
```

Educational. Not audited, not for real funds.
