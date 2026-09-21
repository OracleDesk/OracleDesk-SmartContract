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
from math import isqrt
import random

BPS = 10_000
MAX_SETS = 1_000_000_000_000_000  # 1e15 = 100M USDC (7 dp)
MIN_PROB_BPS = 100
MAX_PROB_BPS = 9_900


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


def run_all():
    _check_known_values()
    _check_seed_opens_at_requested_probability()
    _check_k_never_decreases_and_round_trip_never_profits()
    _check_gross_for_shares_inverts_calc_sell()
    _check_void_never_overpays()
    print("fpmm_model: all property checks passed")


if __name__ == "__main__":
    run_all()
