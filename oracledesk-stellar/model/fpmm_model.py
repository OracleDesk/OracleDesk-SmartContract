"""Python mirror of contracts/market-core/src/math.rs.

Kept in lockstep with the Rust module by hand (both are short and
self-contained) and exercised by the property tests at the bottom of this
file, which run with no dependencies beyond the standard library:

    python3 model/fpmm_model.py

This is also where the off-chain inverse for "sell N shares" lives
(`gross_for_shares`): the contract's `sell` takes an exact collateral amount
(no on-chain sqrt), so a client that wants to sell a specific share count
computes the matching collateral_out here, then calls `sell` with a
`max_shares_in` slippage bound. `agents/core` ports this same function to
TypeScript (BigInt) for the trading agent; both must agree with this model.

Conventions match math.rs: all amounts are non-negative ints in collateral
base units (whatever `decimals()` the collateral token reports, 0..=18).
Rounding always favours the pool.
"""

from dataclasses import dataclass
from math import isqrt
import json
import random
from pathlib import Path

BPS = 10_000
# Deprecated 7-decimal alias, kept for tests only. Contract logic derives its
# bounds from `bounds_for_decimals`; see math.rs.
MAX_SETS = 1_000_000_000_000_000  # 1e15 = 100M USDC (7 dp)
MIN_PROB_BPS = 100
MAX_PROB_BPS = 9_900

I128_MAX = (1 << 127) - 1
MAX_SUPPORTED_DECIMALS = 18


class MathError(Exception):
    pass


@dataclass(frozen=True)
class Bounds:
    min_seed: int
    max_sets: int


def bounds_for_decimals(d: int) -> Bounds:
    """Mirrors math.rs::bounds_for_decimals: min_seed = 100 * 10^d,
    max_sets = 1e8 * 10^d. Rejects d > 18 (UnsupportedDecimals on-chain)."""
    if d < 0 or d > MAX_SUPPORTED_DECIMALS:
        raise MathError("unsupported decimals")
    scale = 10**d
    return Bounds(min_seed=100 * scale, max_sets=100_000_000 * scale)


def _fits_i128(x: int) -> bool:
    return 0 <= x <= I128_MAX


def mul_div_floor(a: int, b: int, c: int) -> int:
    if a < 0 or b < 0 or c <= 0:
        raise MathError("invalid input")
    q = (a * b) // c
    if not _fits_i128(q):
        raise MathError("overflow")
    return q


def mul_div_ceil(a: int, b: int, c: int) -> int:
    if a < 0 or b < 0 or c <= 0:
        raise MathError("invalid input")
    p = a * b
    q = p // c
    q = q + 1 if p % c != 0 else q
    if not _fits_i128(q):
        raise MathError("overflow")
    return q


def price_yes_bps(reserve_yes: int, reserve_no: int) -> int:
    total = reserve_yes + reserve_no
    if total <= 0:
        raise MathError("insufficient liquidity")
    return mul_div_floor(reserve_no, BPS, total)


@dataclass(frozen=True)
class SeedReserves:
    reserve_yes: int
    reserve_no: int
    creator_yes: int
    creator_no: int


def seed_reserves(seed: int, yes_bps: int) -> SeedReserves:
    if seed <= 0 or yes_bps < MIN_PROB_BPS or yes_bps > MAX_PROB_BPS:
        raise MathError("invalid input")
    p = yes_bps
    if p >= BPS // 2:
        reserve_yes, reserve_no = mul_div_floor(seed, BPS - p, p), seed
    else:
        reserve_yes, reserve_no = seed, mul_div_floor(seed, p, BPS - p)
    if reserve_yes <= 0 or reserve_no <= 0:
        raise MathError("invalid input")
    return SeedReserves(reserve_yes, reserve_no, seed - reserve_yes, seed - reserve_no)


@dataclass(frozen=True)
class BuyQuote:
    shares_out: int
    fee: int
    net: int
    new_reserve_bought: int
    new_reserve_other: int


def calc_buy(r_bought: int, r_other: int, collateral_in: int, fee_bps: int) -> BuyQuote:
    if collateral_in <= 0 or r_bought <= 0 or r_other <= 0:
        raise MathError("invalid input")
    fee = mul_div_ceil(collateral_in, fee_bps, BPS)
    net = collateral_in - fee
    if net <= 0:
        raise MathError("invalid input")
    new_other = r_other + net
    new_bought = mul_div_ceil(r_bought, r_other, new_other)
    shares_out = r_bought + net - new_bought
    if shares_out <= 0:
        raise MathError("invalid input")
    return BuyQuote(shares_out, fee, net, new_bought, new_other)


@dataclass(frozen=True)
class SellQuote:
    shares_in: int
    fee: int
    gross: int
    new_reserve_sold: int
    new_reserve_other: int


def calc_sell(r_sold: int, r_other: int, collateral_out: int, fee_bps: int) -> SellQuote:
    if collateral_out <= 0 or r_sold <= 0 or r_other <= 0 or fee_bps >= BPS:
        raise MathError("invalid input")
    gross = mul_div_ceil(collateral_out, BPS, BPS - fee_bps)
    fee = gross - collateral_out
    if gross >= r_other:
        raise MathError("insufficient liquidity")
    new_other = r_other - gross
    new_sold = mul_div_ceil(r_sold, r_other, new_other)
    shares_in = new_sold + gross - r_sold
    if shares_in <= 0:
        raise MathError("invalid input")
    return SellQuote(shares_in, fee, gross, new_sold, new_other)


def split_fee(fee: int, protocol_share_bps: int) -> tuple[int, int]:
    """Split a trade fee into (protocol, lp) portions. Mirrors
    math.rs::split_fee: the protocol share is rounded up so the pool can
    never be left with a negative LP side."""
    if fee < 0 or protocol_share_bps > BPS:
        raise MathError("invalid input")
    protocol = mul_div_ceil(fee, protocol_share_bps, BPS)
    return protocol, fee - protocol


def settle_value(kind: str, yes: int, no: int) -> int:
    if kind == "yes":
        return yes
    if kind == "no":
        return no
    if kind == "void":
        total = yes + no
        if not _fits_i128(total):
            raise MathError("overflow")
        return total // 2
    raise ValueError(f"unknown settlement kind {kind!r}")


def gross_for_shares(r_sold: int, r_other: int, shares_in: int, fee_bps: int) -> int:
    """Off-chain inverse of calc_sell: how many complete sets (`gross`) the
    pool must burn so that selling exactly `shares_in` shares balances the
    constant-product invariant, ignoring the contract's integer rounding.

    Solves (shares_in + r_sold - x)(r_other - x) = r_sold * r_other for the
    smaller root of x (the pool never burns more than r_other).
    """
    if shares_in <= 0 or r_sold <= 0 or r_other <= 0 or fee_bps >= BPS:
        raise MathError("invalid input")
    a = shares_in + r_sold
    b = a + r_other
    disc = b * b - 4 * r_other * shares_in
    if disc < 0:
        raise MathError("insufficient liquidity")
    root = isqrt(disc)
    gross = (b - root) // 2
    if gross <= 0 or gross >= r_other:
        raise MathError("insufficient liquidity")
    return gross


def collateral_out_for_shares(r_sold: int, r_other: int, shares_in: int, fee_bps: int) -> int:
    """Estimated `collateral_out` for selling `shares_in` shares, rounded
    down (pool-favoring) so the real on-chain `sell` call — given this value
    and a `max_shares_in` slippage bound of `shares_in` — should not need
    more shares than the caller intended to sell."""
    gross = gross_for_shares(r_sold, r_other, shares_in, fee_bps)
    return mul_div_floor(gross, BPS - fee_bps, BPS)


COLLATERAL_SEARCH_STEPS = 256


def collateral_for_shares(r_bought: int, r_other: int, shares_target: int, fee_bps: int) -> int:
    """Minimum collateral_in for which calc_buy returns at least shares_target.

    Closed-form estimate of the net amount, grossed up for the fee, then a
    bounded binary search against calc_buy itself so integer rounding cannot
    make it wrong. Mirrors agents/core/fpmm.ts::collateralForShares (#108).
    """
    if shares_target <= 0 or r_bought <= 0 or r_other <= 0 or not 0 <= fee_bps < BPS:
        raise MathError("invalid input")

    def shares_for(c: int) -> int:
        if c <= 0:
            return 0
        try:
            return calc_buy(r_bought, r_other, c, fee_bps).shares_out
        except MathError:
            return 0

    b = r_bought + r_other - shares_target
    net = (isqrt(b * b + 4 * shares_target * r_other) - b) // 2
    estimate = mul_div_ceil(net if net > 0 else 1, BPS, BPS - fee_bps)
    hi, steps = estimate, 0
    while shares_for(hi) < shares_target:
        hi = hi * 2 + 1
        steps += 1
        if steps > COLLATERAL_SEARCH_STEPS:
            raise MathError("target not reachable")
    lo = hi - 64 if hi > 64 else 0
    while lo > 0 and shares_for(lo) >= shares_target:
        lo //= 2
        steps += 1
        if steps > COLLATERAL_SEARCH_STEPS:
            raise MathError("search did not converge")
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if shares_for(mid) >= shares_target:
            hi = mid
        else:
            lo = mid
        steps += 1
        if steps > COLLATERAL_SEARCH_STEPS:
            raise MathError("search did not converge")
    return hi


def price_after(outcome_is_yes: bool, r_after: int, r_other_after: int) -> int:
    """YES price in bps of the pool **after** applying an outcome-relative
    reserve update (the `new_reserve_*` pair of a BuyQuote/SellQuote).
    Mirrors math.rs::price_after: pass `outcome_is_yes=False` for a NO trade,
    where `r_after` is the NO reserve."""
    if outcome_is_yes:
        return price_yes_bps(r_after, r_other_after)
    return price_yes_bps(r_other_after, r_after)


def price_after_buy(taken_is_yes: bool, quote: BuyQuote) -> int:
    """Post-trade YES price of a `calc_buy` quote for the outcome the buyer
    receives (`taken_is_yes=False` for a NO buy). This is what the
    per-market impact breaker measures against the pre-trade price."""
    return price_after(taken_is_yes, quote.new_reserve_bought, quote.new_reserve_other)


def price_after_sell(taken_is_yes: bool, quote: SellQuote) -> int:
    """Post-trade YES price of a `calc_sell` quote for the outcome the seller
    gave up (`taken_is_yes=False` for a NO sell)."""
    return price_after(taken_is_yes, quote.new_reserve_sold, quote.new_reserve_other)


def buy_within_limit(collateral_in: int, shares_out: int, limit_bps: int) -> bool:
    """True when a buy's average execution price `collateral_in / shares_out`
    (fees included) is at most `limit_bps` per share. Compared by
    cross-multiplication so rounding cannot flip the decision; exact
    equality passes. Mirrors math.rs::buy_within_limit."""
    if collateral_in < 0 or shares_out <= 0:
        raise MathError("invalid input")
    return collateral_in * BPS <= shares_out * limit_bps


def sell_within_limit(collateral_out: int, shares_in: int, limit_bps: int) -> bool:
    """True when a sell's average execution price `collateral_out / shares_in`
    is at least `limit_bps` per share. Exact equality passes; a zero limit is
    trivially satisfied, which buys the caller no protection. Mirrors
    math.rs::sell_within_limit."""
    if collateral_out < 0 or shares_in <= 0:
        raise MathError("invalid input")
    return collateral_out * BPS >= shares_in * limit_bps


# ---------------------------------------------------------------------------
# Property tests. No pytest/hypothesis dependency: run directly.
# ---------------------------------------------------------------------------


def _check_known_values():
    """Pins the same worked examples as math.rs's unit tests, so a porting
    mistake between the two languages is caught immediately."""
    q = calc_buy(1000, 1000, 100, 0)
    assert (q.shares_out, q.new_reserve_bought, q.new_reserve_other) == (190, 910, 1100), q

    q = calc_sell(1000, 1000, 100, 0)
    assert (q.shares_in, q.gross, q.new_reserve_sold, q.new_reserve_other) == (
        212,
        100,
        1112,
        900,
    ), q

    assert split_fee(100, 0) == (0, 100)
    assert split_fee(100, BPS) == (100, 0)
    assert split_fee(101, 5_000) == (51, 50)


def _check_known_values_18dp():
    """18-decimal fixtures matching math.rs's known_values_18dp test. The
    1000/1000 -> 190 example scaled by 10**11, plus a seed at max_sets."""
    scale = 10**11  # 7 dp -> 18 dp
    q = calc_buy(1000 * scale, 1000 * scale, 100 * scale, 0)
    assert (
        q.shares_out,
        q.new_reserve_bought,
        q.new_reserve_other,
    ) == (19090909090909, 90909090909091, 110000000000000), q

    bounds = bounds_for_decimals(18)
    assert bounds.min_seed == 100 * 10**18
    assert bounds.max_sets == 100_000_000 * 10**18


if __name__ == "__main__":
    _check_known_values()
    _check_known_values_18dp()
    print("fpmm_model: all checks passed")
