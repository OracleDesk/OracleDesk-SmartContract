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
base units (USDC on Stellar = 7 decimals). Rounding always favours the pool.
"""

from dataclasses import dataclass
import json
import os
from math import isqrt
import random
from pathlib import Path

BPS = 10_000
MAX_SETS = 1_000_000_000_000_000  # 1e15 = 100M USDC (7 dp)
MIN_PROB_BPS = 100
MAX_PROB_BPS = 9_900
MAX_RAMP_SECS = 30 * 86_400
MAX_SKEW_MULT_BPS = 1_000


class MathError(Exception):
    pass


def mul_div_floor(a: int, b: int, c: int) -> int:
    if a < 0 or b < 0 or c <= 0:
        raise MathError("invalid input")
    return (a * b) // c


def mul_div_ceil(a: int, b: int, c: int) -> int:
    if a < 0 or b < 0 or c <= 0:
        raise MathError("invalid input")
    p = a * b
    q = p // c
    return q + 1 if p % c != 0 else q


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
        return (yes + no) // 2
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
# Categorical (N-outcome) FPMM — mirrors math_categorical.rs.
# The binary invariant k = r_yes * r_no generalises to the product of all
# reserves; the iterative ceil accumulation keeps k non-decreasing with at
# most n-1 units of pool-favouring drift per trade (see the rounding proof in
# math_categorical.rs::calc_buy).
# ---------------------------------------------------------------------------

MAX_MARKET_OUTCOMES = 8
PRICE_SCALE = 1_000_000_000_000_000_000  # 1e18, same reciprocal scale as math_categorical.rs


def _cat_n(reserves) -> int:
    n = len(reserves)
    if not 2 <= n <= MAX_MARKET_OUTCOMES:
        raise MathError("invalid input")
    if any(r <= 0 for r in reserves):
        raise MathError("invalid input")
    return n


def _cat_index(n: int, outcome_index: int) -> int:
    if not 0 <= outcome_index < n:
        raise MathError("invalid input")
    return outcome_index


@dataclass(frozen=True)
class CatBuyQuote:
    shares_out: int
    fee: int
    net: int
    new_reserves: list


def cat_calc_buy(reserves, outcome_index: int, collateral_in: int, fee_bps: int) -> CatBuyQuote:
    """Buy `collateral_in` of outcome `outcome_index`: mint `net` sets into
    every other reserve and shrink the bought reserve so the product of all
    reserves holds. Mirrors math_categorical.rs::calc_buy."""
    n = _cat_n(reserves)
    j = _cat_index(n, outcome_index)
    if collateral_in <= 0:
        raise MathError("invalid input")
    fee = mul_div_ceil(collateral_in, fee_bps, BPS)
    net = collateral_in - fee
    if net <= 0:
        raise MathError("invalid input")
    new_reserves = list(reserves)
    acc = reserves[j]
    for i in range(n):
        if i == j:
            continue
        new_other = reserves[i] + net
        new_reserves[i] = new_other
        acc = mul_div_ceil(acc, reserves[i], new_other)
    new_reserves[j] = acc
    shares_out = reserves[j] + net - acc
    if shares_out <= 0:
        raise MathError("invalid input")
    return CatBuyQuote(shares_out, fee, net, new_reserves)


@dataclass(frozen=True)
class CatSellQuote:
    shares_in: int
    fee: int
    gross: int
    new_reserves: list


def cat_calc_sell(reserves, outcome_index: int, collateral_out: int, fee_bps: int) -> CatSellQuote:
    """Sell `outcome_index` for an exact `collateral_out` (Gnosis-style, so
    no square root on-chain). Mirrors math_categorical.rs::calc_sell."""
    n = _cat_n(reserves)
    j = _cat_index(n, outcome_index)
    if collateral_out <= 0 or fee_bps >= BPS:
        raise MathError("invalid input")
    gross = mul_div_ceil(collateral_out, BPS, BPS - fee_bps)
    fee = gross - collateral_out
    new_reserves = list(reserves)
    acc = reserves[j]
    for i in range(n):
        if i == j:
            continue
        if reserves[i] <= gross:
            raise MathError("insufficient liquidity")
        new_other = reserves[i] - gross
        new_reserves[i] = new_other
        acc = mul_div_ceil(acc, reserves[i], new_other)
    new_reserves[j] = acc
    shares_in = acc + gross - reserves[j]
    if shares_in <= 0:
        raise MathError("invalid input")
    return CatSellQuote(shares_in, fee, gross, new_reserves)


def cat_prices(reserves) -> list:
    """Spot price of every outcome in bps, `p_j = (1/r_j) / Σ(1/r_i)`
    evaluated on integer reciprocals. Each price floors, so the n prices sum
    to at most BPS and at least BPS - n (display-only; never trade math).
    Mirrors math_categorical.rs::prices_bps."""
    n = _cat_n(reserves)
    recs = [PRICE_SCALE // reserves[i] for i in range(n)]
    total = sum(recs)
    if total <= 0:
        raise MathError("insufficient liquidity")
    return [mul_div_floor(BPS, rec, total) for rec in recs]


@dataclass(frozen=True)
class CatSeed:
    reserves: list
    creator_shares: list


def cat_seed(seed: int, probs_bps) -> CatSeed:
    """Open a pool at the requested probabilities: each reserve is
    `seed * p_min / p_i` (floored), the creator keeps `seed - r_i` of every
    outcome. `probs_bps` must have length 2..=MAX_MARKET_OUTCOMES, every
    entry >= MIN_PROB_BPS, and the entries must sum to exactly BPS.
    Mirrors math_categorical.rs::seed_reserves."""
    n = len(probs_bps)
    if not 2 <= n <= MAX_MARKET_OUTCOMES or seed <= 0:
        raise MathError("invalid input")
    if any(p < MIN_PROB_BPS for p in probs_bps):
        raise MathError("invalid input")
    if sum(probs_bps) != BPS:
        raise MathError("invalid input")
    p_min = min(probs_bps)
    reserves = []
    creator_shares = []
    for p in probs_bps:
        r = mul_div_floor(seed, p_min, p)
        if r <= 0:
            raise MathError("invalid input")
        reserves.append(r)
        creator_shares.append(seed - r)
    return CatSeed(reserves, creator_shares)


def cat_settle_value(resolved, balances) -> int:
    """Collateral value of one holder's per-outcome balances once final.
    `resolved=w` pays the winning balance; `resolved=None` (void) pays
    `floor(Σ balances / n)`. Every complete set is worth exactly 1 and every
    rounding floors, so the total paid across holders never exceeds
    sets_minted. Mirrors math_categorical.rs::settle_value."""
    n = len(balances)
    if not 2 <= n <= MAX_MARKET_OUTCOMES:
        raise MathError("invalid input")
    if resolved is None:
        if any(b < 0 for b in balances):
            raise MathError("invalid input")
        return sum(balances) // n
    _cat_index(n, resolved)
    return balances[resolved]


# ---------------------------------------------------------------------------
# Scalar (range) market settlement — mirrors math.rs::scalar_payout, which
# backs the Rust `Settlement::Scalar(p)` variant. Kept as its own function
# here because the Python `settle_value(kind, yes, no)` has no slot for the
# resolved payout; `scalar_payout(BPS, ...)` == yes and `(0, ...)` == no.
# ---------------------------------------------------------------------------


def scalar_payout(payout_long_bps: int, yes: int, no: int) -> int:
    """Collateral value of a (yes, no) share pair when the resolved value
    maps to `payout_long_bps` LONG per complete set. Both legs floor
    independently, so no holder ever beats their exact rational share."""
    return (yes * payout_long_bps) // BPS + (no * (BPS - payout_long_bps)) // BPS


# ---------------------------------------------------------------------------
# Dynamic fee schedule — mirrors math.rs::effective_fee_bps. Deterministic
# integer math shared with the contract and agents/core/fpmm.ts via
# model/fee_fixtures.json; every floor rounds toward the trader (a lower fee
# never harms the pool, whose protection is calc_* rounding).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FeeSchedule:
    base_bps: int
    max_bps: int
    ramp_secs: int
    skew_mult_bps: int


def effective_fee_bps(schedule: FeeSchedule, now: int, close_time: int, r_yes: int, r_no: int) -> int:
    """Fee in bps for a trade at `now` with the given pre-trade reserves:
    `min(max, base + time_ramp + skew)`. The ramp adds up to `max - base`
    linearly over the last `ramp_secs` before close (0 disables it, and any
    timestamp at or past close clamps to the full ramp); the skew term adds
    `skew_mult_bps` per 1000 bps of distance from a 50/50 price. Guaranteed
    `base <= result <= max`, and `max < BPS` is validated so `calc_sell` is
    always well-defined."""
    if schedule.base_bps > schedule.max_bps or schedule.max_bps >= BPS:
        raise MathError("invalid input")
    if schedule.ramp_secs == 0:
        t = 0
    else:
        if now >= close_time:
            into_ramp = schedule.ramp_secs
        else:
            into_ramp = max(0, schedule.ramp_secs - (close_time - now))
        t = mul_div_floor(into_ramp, schedule.max_bps - schedule.base_bps, schedule.ramp_secs)
    p = price_yes_bps(r_yes, r_no)
    skew = mul_div_floor(abs(p - BPS // 2), schedule.skew_mult_bps, 1_000)
    return min(schedule.max_bps, schedule.base_bps + t + skew)


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


def _check_seed_opens_at_requested_probability():
    for p in (100, 2500, 5000, 7300, 9900):
        s = seed_reserves(10_000_000_000, p)
        price = price_yes_bps(s.reserve_yes, s.reserve_no)
        assert abs(price - p) <= 1, (p, price)
        assert s.creator_yes == 0 or s.creator_no == 0


def _check_k_never_decreases_and_round_trip_never_profits(trials: int = 2_000, seed: int = 7):
    rng = random.Random(seed)
    for _ in range(trials):
        ry = rng.randint(1_000_000, 1_000_000_000)
        rn = rng.randint(1_000_000, 1_000_000_000)
        amt = rng.randint(1, max(1, min(ry, rn) // 2))
        fee_bps = rng.randint(0, 299)
        k0 = ry * rn
        q = calc_buy(ry, rn, amt, fee_bps)
        assert q.new_reserve_bought * q.new_reserve_other >= k0
        try:
            s = calc_sell(q.new_reserve_bought, q.new_reserve_other, amt, fee_bps)
        except MathError:
            continue
        assert s.shares_in >= q.shares_out, "free money"


def _check_gross_for_shares_inverts_calc_sell(trials: int = 2_000, seed: int = 11):
    """For a shares_in target derived from a real calc_sell call, the
    estimated collateral_out must round-trip through the *real* calc_sell to
    a shares_in within a one-unit rounding tolerance of the original request.

    The quadratic solve is over continuous reals; calc_sell's ceil-rounding
    can then push the result up by a unit of the smallest collateral
    denomination. This is exactly why market-core's `sell` takes a
    `max_shares_in` slippage bound rather than requiring an exact match —
    callers should pad it a little further for their own safety margin, not
    treat this tolerance as the only slippage protection they need.
    """
    rng = random.Random(seed)
    checked = 0
    for _ in range(trials):
        r_sold = rng.randint(1_000_000, 1_000_000_000)
        r_other = rng.randint(1_000_000, 1_000_000_000)
        fee_bps = rng.randint(0, 299)
        collateral_out = rng.randint(1, max(1, r_other // 4))
        try:
            forward = calc_sell(r_sold, r_other, collateral_out, fee_bps)
        except MathError:
            continue
        try:
            estimated_out = collateral_out_for_shares(r_sold, r_other, forward.shares_in, fee_bps)
        except MathError:
            continue
        if estimated_out <= 0:
            continue
        back = calc_sell(r_sold, r_other, estimated_out, fee_bps)
        assert back.shares_in <= forward.shares_in + 1, (forward, back)
        checked += 1
    assert checked > trials // 2, "too many trials skipped, weakens the property check"


def _check_void_never_overpays():
    assert settle_value("void", 3, 4) == 3
    assert settle_value("void", 5, 5) <= 5


def _check_price_after_maps_both_sides():
    """Mirrors math.rs's price_after tests: outcome_is_yes selects which of
    the two post-trade reserves is the YES reserve."""
    for r, other in ((1000, 1000), (910, 1100), (1, 9999), (5893, 4107)):
        assert price_after(True, r, other) == price_yes_bps(r, other)
        assert price_after(False, r, other) == price_yes_bps(other, r)

    # Worked example shared by all three mirrors: buying 10 USDC of YES in a
    # 100-sets pool at 50% with a 1% fee moves YES from 5000 to 5470 bps.
    q = calc_buy(1_000_000_000, 1_000_000_000, 100_000_000, 100)
    assert price_yes_bps(1_000_000_000, 1_000_000_000) == 5000
    assert price_after_buy(True, q) == 5470
    # Selling right back must not land above the pre-trade price: two fees
    # and pool-favoring rounding always leave the seller worse off.
    s = calc_sell(q.new_reserve_bought, q.new_reserve_other, 100_000_000, 100)
    assert price_after_sell(True, s) < 5000


def _check_limits_boundary_and_symmetry():
    # Exact equality passes, one unit over fails, in both directions.
    assert buy_within_limit(100, 100, 10_000)
    assert buy_within_limit(100, 101, 10_000)
    assert not buy_within_limit(101, 100, 10_000)
    assert buy_within_limit(100, 200, 5_000)
    assert not buy_within_limit(101, 200, 5_000)
    assert sell_within_limit(100, 100, 10_000)
    assert not sell_within_limit(99, 100, 10_000)
    assert sell_within_limit(100, 200, 5_000)
    assert not sell_within_limit(100, 201, 5_000)
    # A zero limit is trivially satisfied for sells (documented as "no
    # protection") and only binds a buy at a zero average price.
    assert sell_within_limit(0, 1, 0)
    assert not buy_within_limit(1, 1, 0)


def _check_cat_known_values():
    """Pins the same worked examples as math_categorical.rs's unit test: a
    3-outcome 1000/1000/1000 pool, buying/selling 100 of outcome 0 with no
    fee."""
    q = cat_calc_buy([1000, 1000, 1000], 0, 100, 0)
    assert (q.shares_out, q.new_reserves) == (272, [828, 1100, 1100]), q
    s = cat_calc_sell([1000, 1000, 1000], 0, 100, 0)
    assert (s.shares_in, s.new_reserves) == (336, [1236, 900, 900]), s

    # A 2-outcome categorical pool is the binary FPMM: same fee and net, and
    # a bought-reserve result within one unit of rounding.
    for amt, fee in ((100, 0), (100_000_000, 100), (7, 30)):
        bin_q = calc_buy(1_000_000, 3_000_000, amt, fee)
        cat_q = cat_calc_buy([1_000_000, 3_000_000], 0, amt, fee)
        assert cat_q.fee == bin_q.fee and cat_q.net == bin_q.net
        assert cat_q.new_reserves[1] == bin_q.new_reserve_other
        assert abs(cat_q.shares_out - bin_q.shares_out) <= 1


def _check_cat_k_never_decreases_and_round_trip_never_profits(trials: int = 2_000, seed: int = 13):
    rng = random.Random(seed)
    for _ in range(trials):
        n = rng.randint(2, MAX_MARKET_OUTCOMES)
        reserves = [100 + rng.randint(0, 9_999) for _ in range(n)]
        j = rng.randint(0, n - 1)
        amt = 100 + rng.randint(0, 99)
        fee = rng.randint(0, 299)

        k0 = 1
        for r in reserves:
            k0 *= r
        q = cat_calc_buy(reserves, j, amt, fee)
        k1 = 1
        for r in q.new_reserves:
            k1 *= r
        assert k1 >= k0, (reserves, j, amt, fee)
        for i, r in enumerate(reserves):
            if i != j:
                assert q.new_reserves[i] == r + q.net

        try:
            s = cat_calc_sell(q.new_reserves, j, amt, fee)
        except MathError:
            continue
        assert s.shares_in >= q.shares_out, "free money"


def _check_cat_prices_sum_within_n_of_bps(trials: int = 2_000, seed: int = 17):
    rng = random.Random(seed)
    for _ in range(trials):
        n = rng.randint(2, MAX_MARKET_OUTCOMES)
        reserves = [1_000 + rng.randint(0, 999_999_999_999) for _ in range(n)]
        prices = cat_prices(reserves)
        assert BPS - n <= sum(prices) <= BPS, (reserves, prices)
    # Equal reserves -> equal prices, each exactly floor(BPS / n).
    for n in range(2, MAX_MARKET_OUTCOMES + 1):
        prices = cat_prices([7_777] * n)
        assert prices == [BPS // n] * n


def _check_cat_seed_matches_requested_probs():
    for probs in ([5000, 5000], [6800, 3200], [5000, 3000, 2000], [9000, 500, 400, 100]):
        s = cat_seed(1_000_000_000, probs)
        prices = cat_prices(s.reserves)
        for i, p in enumerate(probs):
            assert abs(prices[i] - p) <= 2, (probs, prices)
            assert s.reserves[i] + s.creator_shares[i] == 1_000_000_000
        # The least likely outcome is fully held by the pool.
        assert s.creator_shares[probs.index(min(probs))] == 0
    # 8 equal outcomes: prices sum to exactly BPS, creator holds nothing.
    s = cat_seed(1_000_000_000, [1250] * 8)
    assert cat_prices(s.reserves) == [1250] * 8
    assert s.reserves == [1_000_000_000] * 8
    assert s.creator_shares == [0] * 8
    # Validation: sum != BPS, below MIN_PROB_BPS, n out of range, seed 0.
    for probs, seed in (([6000, 3000], 1_000), ([9950, 50], 1_000), ([10_000], 1_000), ([1250] * 9, 1_000), ([5000, 5000], 0)):
        try:
            cat_seed(seed, probs)
        except MathError:
            continue
        raise AssertionError(f"cat_seed accepted {probs} seed={seed}")


def _check_cat_settle_never_overpays(trials: int = 1_000, seed: int = 23):
    rng = random.Random(seed)
    for _ in range(trials):
        n = rng.randint(2, MAX_MARKET_OUTCOMES)
        sets = 1_000_000
        # Three holders share each outcome's `sets` shares with the pool.
        held = [[0] * 3 for _ in range(n)]
        for i in range(n):
            rest = sets
            for h in range(3):
                take = rest if h == 2 else rng.randint(0, rest)
                held[i][h] = take
                rest -= take
        w = rng.randint(0, n - 1)
        resolved_total = 0
        void_total = 0
        for h in range(3):
            balances = [held[i][h] for i in range(n)]
            resolved_total += cat_settle_value(w, balances)
            void_total += cat_settle_value(None, balances)
        assert resolved_total <= sets
        assert void_total <= sets, (held, void_total)
    # Worked shape checks, mirroring the Rust unit test.
    assert cat_settle_value(1, [3, 7, 11]) == 7
    assert cat_settle_value(None, [3, 7, 11]) == 7  # 21 / 3
    assert cat_settle_value(None, [1] * 7) == 1


def _check_scalar_payout_never_overpays(trials: int = 1_000, seed: int = 29):
    rng = random.Random(seed)
    # Extremes reduce to the binary legs.
    assert scalar_payout(BPS, 5, 7) == settle_value("yes", 5, 7)
    assert scalar_payout(0, 5, 7) == settle_value("no", 5, 7)
    # A complete set is worth exactly 1 mid-range; rounding always floors.
    assert scalar_payout(5_000, 1_000, 1_000) == 1_000
    assert scalar_payout(3_333, 1_000, 1_000) == 999
    for _ in range(trials):
        sets = rng.randint(1, 1_000_000)
        payout = rng.randint(0, BPS)
        # Three holders split `sets` YES and `sets` NO shares among them
        # (the last holder takes the remainder, so the split is exact).
        total = 0
        yes_left = sets
        no_left = sets
        for h in range(3):
            take_y = yes_left if h == 2 else rng.randint(0, yes_left)
            take_n = no_left if h == 2 else rng.randint(0, no_left)
            yes_left -= take_y
            no_left -= take_n
            total += scalar_payout(payout, take_y, take_n)
        # Both legs floor, so Σ paid <= Σ(yes*p + no*(BPS-p))/BPS == sets.
        assert total <= sets, (sets, payout, total)


def _check_effective_fee_bounds(trials: int = 2_000, seed: int = 31):
    rng = random.Random(seed)
    for _ in range(trials):
        base = rng.randint(0, 999)
        max_bps = rng.randint(base, 1_000)
        ramp = rng.randint(0, MAX_RAMP_SECS)
        skew_mult = rng.randint(0, MAX_SKEW_MULT_BPS)
        close = rng.randint(1_000, 2_000_000_000)
        now = rng.randint(0, close + 10_000)
        r_yes = rng.randint(1, 10**15)
        r_no = rng.randint(1, 10**15)
        fee = effective_fee_bps(FeeSchedule(base, max_bps, ramp, skew_mult), now, close, r_yes, r_no)
        assert base <= fee <= max_bps <= 1_000, (base, max_bps, ramp, skew_mult, now, close, fee)
    # Ramp monotonic in time: the fee never decreases as close approaches.
    sched = FeeSchedule(100, 800, 10_000, 0)
    prev = -1
    for t in range(2_000_000 - 20_000, 2_000_000 + 5_000 + 1, 137):
        fee = effective_fee_bps(sched, t, 2_000_000, 1_000, 1_000)
        assert fee >= prev
        prev = fee
    assert prev == 800  # any timestamp at/past close applies the full ramp
    # Zero ramp means "no ramp": the fee is flat all the way to close.
    flat = FeeSchedule(100, 800, 0, 0)
    assert effective_fee_bps(flat, 0, 2_000_000, 1_000, 1_000) == 100
    assert effective_fee_bps(flat, 2_000_000, 2_000_000, 1_000, 1_000) == 100
    # Skew symmetric around 50/50 for representable ratios.
    for q in ((1000, 3000), (900, 1100), (5000, 5000), (1, 4), (7, 3), (1, 1)):
        sched_s = FeeSchedule(100, 1_000, 0, 500)
        left = effective_fee_bps(sched_s, 0, 1, q[0], q[1])
        right = effective_fee_bps(sched_s, 0, 1, q[1], q[0])
        assert left == right, (q, left, right)
    # The pure function only requires base <= max < BPS; the tighter
    # MAX_FEE_BPS cap is the contract layer's job (validate_schedule), so a
    # (1_000, 1_000) schedule is valid here.
    assert effective_fee_bps(FeeSchedule(1_000, 1_000, 0, 0), 0, 1, 1_000, 1_000) == 1_000
    for bad in (FeeSchedule(500, 100, 0, 0), FeeSchedule(0, 10_000, 0, 0)):
        try:
            effective_fee_bps(bad, 0, 1, 1_000, 1_000)
        except MathError:
            continue
        raise AssertionError(f"effective_fee_bps accepted {bad}")


def _check_effective_fee_known_values():
    """Shared cross-language table (also read by math.rs's
    effective_fee_matches_fixtures and agents/core/fpmm.test.ts): one row per
    fixture, nine numbers — [base_bps, max_bps, ramp_secs, skew_mult_bps,
    now, close, r_yes, r_no, expected_fee_bps]."""
    fixtures = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fee_fixtures.json")
    with open(fixtures, encoding="utf-8") as f:
        rows = json.load(f)
    assert rows, "fee_fixtures.json has no rows"
    for row in rows:
        assert len(row) == 9, row
        sched = FeeSchedule(row[0], row[1], row[2], row[3])
        fee = effective_fee_bps(sched, row[4], row[5], row[6], row[7])
        assert fee == row[8], (row, fee)


def _check_shared_vectors():
    """Replays the committed cross-language vectors.

    The same file is asserted by math.rs::shared_vectors_match and
    agents/core/fpmm.test.ts, so a porting mistake is caught even when the
    differential harness (scripts/fpmm-diff/diff.py) is not running.
    """
    path = Path(__file__).resolve().parents[1] / "scripts/fpmm-diff/vectors.jsonl"
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        case = json.loads(line)
        fn = case["fn"]
        args = case["args"]
        parsers = {
            "calc_buy": lambda a: calc_buy(int(a[0]), int(a[1]), int(a[2]), int(a[3])),
            "calc_sell": lambda a: calc_sell(int(a[0]), int(a[1]), int(a[2]), int(a[3])),
            "seed_reserves": lambda a: seed_reserves(int(a[0]), int(a[1])),
            "mul_div_floor": lambda a: {"value": mul_div_floor(int(a[0]), int(a[1]), int(a[2]))},
            "mul_div_ceil": lambda a: {"value": mul_div_ceil(int(a[0]), int(a[1]), int(a[2]))},
            "price_yes_bps": lambda a: {"value": price_yes_bps(int(a[0]), int(a[1]))},
            "settle_value": lambda a: {"value": settle_value(a[0], int(a[1]), int(a[2]))},
            "gross_for_shares": lambda a: {"gross": gross_for_shares(int(a[0]), int(a[1]), int(a[2]), int(a[3]))},
            "collateral_out_for_shares": lambda a: {
                "collateral_out": collateral_out_for_shares(int(a[0]), int(a[1]), int(a[2]), int(a[3]))
            },
        }
        try:
            out = parsers[fn](args)
        except MathError as exc:
            assert "err" in case, f"vector line {line_no}: unexpected error {exc}"
            continue
        if hasattr(out, "__dict__"):
            out = dict(out.__dict__)
        assert "ok" in case, f"vector line {line_no}: expected an error"
        assert {k: str(v) for k, v in out.items()} == case["ok"], (
            f"vector line {line_no} ({fn}) mismatch: {out} != {case['ok']}"
        )


COLLATERAL_FIXTURES = Path(__file__).resolve().parents[1] / "scripts/fpmm-diff/collateral_for_shares.jsonl"


def _shares_or_zero(r_bought: int, r_other: int, c: int, fee_bps: int) -> int:
    try:
        return calc_buy(r_bought, r_other, c, fee_bps).shares_out if c > 0 else 0
    except MathError:
        return 0


def _check_collateral_for_shares_is_minimal(trials: int = 2_000, seed: int = 13):
    """collateral_for_shares buys the target, and one stroop less does not."""
    rng = random.Random(seed)
    for _ in range(trials):
        r_bought = rng.randint(1, 10**13)
        r_other = rng.randint(1, 10**13)
        fee = rng.choice([0, 1, 30, 100, 250, 9_999])
        target = rng.randint(1, r_bought * 3 + 10)
        c = collateral_for_shares(r_bought, r_other, target, fee)
        assert _shares_or_zero(r_bought, r_other, c, fee) >= target, (r_bought, r_other, target, fee, c)
        assert _shares_or_zero(r_bought, r_other, c - 1, fee) < target, (r_bought, r_other, target, fee, c)


def collateral_fixture_cases(seed: int = 108, count: int = 40):
    rng = random.Random(seed)
    cases = [(1_000, 1_000, 1, 0), (1_000, 1_000, 500, 100), (6_000_000_000, 4_000_000_000, 245_327_043, 100)]
    while len(cases) < count:
        r_bought, r_other = rng.randint(1, 10**12), rng.randint(1, 10**12)
        cases.append((r_bought, r_other, rng.randint(1, r_bought * 2 + 1), rng.choice([0, 30, 100, 300])))
    return cases


def write_collateral_fixtures():
    lines = []
    for r_bought, r_other, target, fee in collateral_fixture_cases():
        c = collateral_for_shares(r_bought, r_other, target, fee)
        lines.append(json.dumps({"args": [str(r_bought), str(r_other), str(target), str(fee)], "collateral_in": str(c)}, sort_keys=True))
    COLLATERAL_FIXTURES.write_text("\n".join(lines) + "\n")
    print(f"wrote {len(lines)} fixtures to {COLLATERAL_FIXTURES}")


def _check_collateral_fixtures():
    """Replays the fixtures agents/core/fpmm.test.ts also asserts."""
    for line_no, line in enumerate(COLLATERAL_FIXTURES.read_text().splitlines(), 1):
        case = json.loads(line)
        a = [int(x) for x in case["args"]]
        got = collateral_for_shares(*a)
        assert str(got) == case["collateral_in"], f"fixture line {line_no}: {got} != {case['collateral_in']}"


def run_all():
    _check_known_values()
    _check_shared_vectors()
    _check_seed_opens_at_requested_probability()
    _check_k_never_decreases_and_round_trip_never_profits()
    _check_gross_for_shares_inverts_calc_sell()
    _check_void_never_overpays()
    _check_price_after_maps_both_sides()
    _check_limits_boundary_and_symmetry()
    _check_collateral_for_shares_is_minimal()
    _check_collateral_fixtures()
    _check_cat_known_values()
    _check_cat_k_never_decreases_and_round_trip_never_profits()
    _check_cat_prices_sum_within_n_of_bps()
    _check_cat_seed_matches_requested_probs()
    _check_cat_settle_never_overpays()
    _check_scalar_payout_never_overpays()
    _check_effective_fee_bounds()
    _check_effective_fee_known_values()
    print("fpmm_model: all property checks passed")


if __name__ == "__main__":
    import sys

    if "--write-collateral-fixtures" in sys.argv:
        write_collateral_fixtures()
    else:
        run_all()
