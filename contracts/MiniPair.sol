// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MiniPair
/// @notice A constant-product (x * y = k) pool for two ERC-20 tokens, in the style of Uniswap V2.
///         The pool's own ERC-20 is the LP share. Swaps pay a 0.30% fee that stays in the reserves,
///         so k grows with every trade and LP shares appreciate.
contract MiniPair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 30; // 0.30%
    uint256 public constant MINIMUM_LIQUIDITY = 1_000; // locked forever on first deposit

    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;

    event Mint(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event Burn(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event Swap(address indexed trader, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    error InsufficientLiquidity();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error InvalidToken();
    error ZeroAmount();
    error Expired();

    constructor(IERC20 _token0, IERC20 _token1) ERC20("MiniSwap LP", "MLP") {
        require(address(_token0) != address(_token1), "identical tokens");
        token0 = _token0;
        token1 = _token1;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    function getReserves() public view returns (uint112, uint112) {
        return (reserve0, reserve1);
    }

    /// @notice Output for an exact input, after the fee: out = (in * 997 * R_out) / (R_in * 1000 + in * 997)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        return (inWithFee * reserveOut) / (reserveIn * 10_000 + inWithFee);
    }

    /// @notice Deposit both tokens. The first depositor sets the price; later deposits should match it,
    ///         and any excess on one side is donated to existing LPs.
    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 shares)
    {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // stops the share price from being manipulated to dust
        } else {
            shares = Math.min((amount0 * supply) / reserve0, (amount1 * supply) / reserve1);
        }
        if (shares == 0 || shares < minShares) revert InsufficientLiquidity();
        _mint(msg.sender, shares);
        _sync();
        emit Mint(msg.sender, amount0, amount1, shares);
    }

    /// @notice Burn LP shares for a pro-rata slice of both reserves (fees included).
    function removeLiquidity(uint256 shares, uint256 min0, uint256 min1, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 supply = totalSupply();
        amount0 = (shares * reserve0) / supply;
        amount1 = (shares * reserve1) / supply;
        if (amount0 < min0) revert InsufficientOutput(amount0, min0);
        if (amount1 < min1) revert InsufficientOutput(amount1, min1);
        _burn(msg.sender, shares);
        token0.safeTransfer(msg.sender, amount0);
        token1.safeTransfer(msg.sender, amount1);
        _sync();
        emit Burn(msg.sender, amount0, amount1, shares);
    }

    /// @notice Sell an exact amount of `tokenIn`. Reverts if the output would fall below `minOut`,
    ///         which is the slippage limit that bounds how much a sandwich attacker can take.
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 amountOut)
    {
        bool zeroForOne;
        if (tokenIn == address(token0)) zeroForOne = true;
        else if (tokenIn != address(token1)) revert InvalidToken();

        (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        amountOut = getAmountOut(amountIn, rIn, rOut);
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        uint256 kBefore = uint256(reserve0) * reserve1;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (zeroForOne ? token1 : token0).safeTransfer(to, amountOut);
        _sync();
        assert(uint256(reserve0) * reserve1 >= kBefore); // the invariant never shrinks

        emit Swap(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    /// @notice Spot price of token0 in token1, scaled by 1e18.
    function spotPrice0() external view returns (uint256) {
        return (uint256(reserve1) * 1e18) / reserve0;
    }

    function _sync() private {
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        require(b0 <= type(uint112).max && b1 <= type(uint112).max, "overflow");
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
        emit Sync(reserve0, reserve1);
    }
}
