"""Python mirror of contracts/market-core/src/math.rs.

Kept in lockstep with the Rust module by hand (both are short and
self-contained) and exercised by the property tests at the bottom of this
file, which run with no dependencies beyond the standard library:

    python3 model/fpmm_model.py

This is also where the off-chain inverse for "sell N shares" lives
(`gross_for_shares` / `collateral_out_for_shares`). The contract now exposes
an exact-share entrypoint (`sell_shares`), backed by `calc_sell_shares` in
math.rs, which this module mirrors bit-for-bit. The older `gross_for_shares`
helpers are kept for backward compatibility but are deprecated in favour of
`calc_sell_shares`. `agents/core` ports both to TypeScript (BigInt) for the
trading agent; all three must agree with this model.

Conventions match math.rs: all amounts are non-negative ints in collateral
base units (USDC on Stellar = 7 decimals). Rounding always favours the pool.
"""

from dataclasses import dataclass
from math import isqrt
import json
import random
from pathlib import Path

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


@dataclass(frozen=True)
class SellSharesQuote:
    collateral_out: int
    fee: int
    gross: int
    new_reserve_sold: int
    new_reserve_other: int


def calc_sell_shares(r_sold: int, r_other: int, shares_in: int, fee_bps: int) -> SellSharesQuote:
    """Exact-share sell: how much collateral_out the pool pays for burning
    exactly `shares_in` shares of the sold outcome.

    Mirrors math.rs::calc_sell_shares bit-for-bit. Solves
    (r_sold + shares_in - x)(r_other - x) = r_sold * r_other for the smaller
    root x (the gross sets burned), then applies a pool-favoring correction
    loop so that `new_sold * new_other >= r_sold * r_other` always holds.

    The correction loop runs at most twice: `isqrt` rounds down, so the
    initial `x0 = (b - isqrt(D)) // 2` can overshoot the real root by at
    most one; each decrement strictly increases the LHS product, and the
    real root already satisfies the invariant.
    """
    if shares_in <= 0 or r_sold <= 0 or r_other <= 0 or fee_bps >= BPS:
        raise MathError("invalid input")
    b = r_sold + shares_in + r_other
    disc = b * b - 4 * r_other * shares_in
    if disc < 0:
        raise MathError("insufficient liquidity")
    x = (b - isqrt(disc)) // 2
    k0 = r_sold * r_other
    while x > 0 and (r_sold + shares_in - x) * (r_other - x) < k0:
        x -= 1
    if x <= 0 or x >= r_other:
        raise MathError("insufficient liquidity")
    collateral_out = mul_div_floor(x, BPS - fee_bps, BPS)
    fee = x - collateral_out
    if collateral_out <= 0:
        raise MathError("invalid input")
    new_sold = r_sold + shares_in - x
    new_other = r_other - x
    return SellSharesQuote(collateral_out, fee, x, new_sold, new_other)


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


def merge_max(yes: int, no: int) -> int:
    """Largest amount of complete sets a holder can merge: the smaller of
    their YES and NO balances. Mirrors math.rs::merge_max; split/merge never
    touch the pool, so this is a pure min over the holder's position."""
    if yes < 0 or no < 0:
        raise MathError("invalid input")
    return min(yes, no)


def settle_upper(kind: str, yes: int, no: int) -> int:
    """Mirror of `math::settle_upper`: an upper bound on the total
    `settle_value` pays out for a set of per-holder (yes, no) claims. Exact
    for yes/no; for void, per-holder floors sum to at most the floor of the
    summed halves, so `finalize_market` reserving the aggregate never
    under-reserves (see `_check_void_sum_of_floors`)."""
    return settle_value(kind, yes, no)


def gross_for_shares(r_sold: int, r_other: int, shares_in: int, fee_bps: int) -> int:
    """Off-chain inverse of calc_sell: how many complete sets (`gross`) the
    pool must burn so that selling exactly `shares_in` shares balances the
    constant-product invariant, ignoring the contract's integer rounding.

    Solves (shares_in + r_sold - x)(r_other - x) = r_sold * r_other for the
    smaller root of x (the pool never burns more than r_other).

    Deprecated: prefer `calc_sell_shares`, which applies the same
    pool-favoring correction loop as the on-chain `sell_shares` entrypoint
    and returns the exact `collateral_out` the contract will pay.
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
    # Deprecated: prefer `calc_sell_shares(...).collateral_out`, which is
    # exact and matches the on-chain `sell_shares` entrypoint.
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


def _check_sell_shares_known_values():
    """Pinned fixtures shared with math.rs and agents/core/fpmm.test.ts.

    The 1000/1000 pool selling 212 shares must yield gross 100 under the
    pool-favoring correction rule (matching calc_sell(1000, 1000, 100, 0)).
    """
    q = calc_sell_shares(1000, 1000, 212, 0)
    assert (q.gross, q.collateral_out, q.fee) == (100, 100, 0), q
    assert (q.new_reserve_sold, q.new_reserve_other) == (1112, 900), q

    # With a 1% fee the seller receives 99 of the 100 gross.
    q = calc_sell_shares(1000, 1000, 212, 100)
    assert q.gross == 100, q
    assert q.collateral_out == 99, q
    assert q.fee == 1, q


# Shared fixture table: (r_sold, r_other, shares_in, fee_bps) ->
# (collateral_out, fee, gross, new_reserve_sold, new_reserve_other).
# Consumed by agents/core/fpmm.test.ts so all three mirrors agree.
SELL_SHARES_FIXTURES = [
    (1000, 1000, 212, 0, 100, 0, 100, 1112, 900),
    (1000, 1000, 212, 100, 99, 1, 100, 1112, 900),
    (1000, 1000, 100, 0, 48, 0, 48, 1052, 952),
]


def sell_shares_fixtures_as_dicts():
    """JSON-serializable form of SELL_SHARES_FIXTURES, consumed by
    agents/core/fpmm.test.ts so the TS mirror checks the exact same table
    without hand-copying tuple literals (which is how the previous
    malformed fixture literal slipped in)."""
    keys = (
        "r_sold",
        "r_other",
        "shares_in",
        "fee_bps",
        "collateral_out",
        "fee",
        "gross",
        "new_reserve_sold",
        "new_reserve_other",
    )
    return [dict(zip(keys, row)) for row in SELL_SHARES_FIXTURES]


def _check_sell_shares_fixture_table():
    for r_sold, r_other, shares_in, fee_bps, out, fee, gross, ns, no in SELL_SHARES_FIXTURES:
        q = calc_sell_shares(r_sold, r_other, shares_in, fee_bps)
        assert (q.collateral_out, q.fee, q.gross, q.new_reserve_sold, q.new_reserve_other) == (
            out,
            fee,
            gross,
            ns,
            no,
        ), (r_sold, r_other, shares_in, fee_bps, q)


def _check_sell_shares_k_non_decreasing(trials: int = 2_000, seed: int = 13):
    rng = random.Random(seed)
    for _ in range(trials):
        r_sold = rng.randint(1_000_000, 1_000_000_000)
        r_other = rng.randint(1_000_000, 1_000_000_000)
        shares_in = rng.randint(1, max(1, min(r_sold, r_other) // 2))
        fee_bps = rng.randint(0, 299)
        k0 = r_sold * r_other
        try:
            q = calc_sell_shares(r_sold, r_other, shares_in, fee_bps)
        except MathError:
            continue
        assert q.new_reserve_sold * q.new_reserve_other >= k0, (r_sold, r_other, shares_in, q)


def _check_sell_shares_never_beats_calc_sell(trials: int = 2_000, seed: int = 17):
    """For the same shares_in, calc_sell_shares must never pay more than
    calc_sell charges for that share count (pool-favoring rounding)."""
    rng = random.Random(seed)
    checked = 0
    for _ in range(trials):
        r_sold = rng.randint(1_000_000, 1_000_000_000)
        r_other = rng.randint(1_000_000, 1_000_000_000)
        shares_in = rng.randint(1, max(1, min(r_sold, r_other) // 2))
        fee_bps = rng.randint(0, 299)
        try:
            q = calc_sell_shares(r_sold, r_other, shares_in, fee_bps)
        except MathError:
            continue
        try:
            back = calc_sell(r_sold, r_other, q.collateral_out, fee_bps)
        except MathError:
            continue
        assert back.shares_in <= shares_in, (r_sold, r_other, shares_in, q, back)
        checked += 1
    assert checked > trials // 2, "too many trials skipped, weakens the property check"


def _check_void_never_overpays():
    assert settle_value("void", 3, 4) == 3
    assert settle_value("void", 5, 5) <= 5


def _check_merge_max_known_values():
    """Pins the same worked examples as math.rs's merge_max tests."""
    assert merge_max(0, 0) == 0
    assert merge_max(5, 0) == 0
    assert merge_max(0, 7) == 0
    assert merge_max(3, 3) == 3
    assert merge_max(10, 4) == 4
    assert merge_max(4, 10) == 4
    assert merge_max(MAX_SETS, MAX_SETS) == MAX_SETS
    try:
        merge_max(-1, 5)
    except MathError:
        pass
    else:
        raise AssertionError("merge_max accepted a negative balance")


def _check_void_sum_of_floors(trials: int = 2_000, seed: int = 13):
    """A void market's finalize must reserve at least what remaining holders
    can still redeem. Each holder's claim floors its own half, so the sum of
    per-holder floors is at most the aggregate floor `settle_upper`:
    floor(a/2) + floor(b/2) <= floor((a + b)/2) for all a, b >= 0."""
    rng = random.Random(seed)
    for _ in range(trials):
        a = rng.randint(0, 1_000_000_000)
        b = rng.randint(0, 1_000_000_000)
        part = settle_value("void", a, 0) + settle_value("void", 0, b)
        assert part <= settle_upper("void", a, b), (a, b, part)
        assert settle_upper("yes", a, b) == settle_value("yes", a, b)
        assert settle_upper("no", a, b) == settle_value("no", a, b)
    # Boundary shapes around odd sums.
    assert settle_value("void", 1, 0) + settle_value("void", 0, 1) <= 1
    assert settle_value("void", 1, 1) + settle_value("void", 0, 1) <= 1


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
    _check_sell_shares_known_values()
    _check_sell_shares_k_non_decreasing()
    _check_sell_shares_never_beats_calc_sell()
    _check_sell_shares_fixture_table()
    _check_void_never_overpays()
    _check_merge_max_known_values()
    _check_void_sum_of_floors()
    _check_price_after_maps_both_sides()
    _check_limits_boundary_and_symmetry()
    _check_collateral_for_shares_is_minimal()
    _check_collateral_fixtures()
    print("fpmm_model: all property checks passed")


if __name__ == "__main__":
    import sys

    if "--write-collateral-fixtures" in sys.argv:
        write_collateral_fixtures()
    else:
        run_all()