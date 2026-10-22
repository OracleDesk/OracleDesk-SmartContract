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
class BuyQuoteWith:
    """`BuyQuote` plus the integrator leg (#24).

    A separate dataclass rather than a new field on `BuyQuote`, on purpose:
    `_check_shared_vectors` compares `out.__dict__` against the committed
    `scripts/fpmm-diff/vectors.jsonl`, and adding `integrator_fee` to
    `BuyQuote` would add an unexpected key to every `calc_buy` vector and
    break them. `math.rs` can carry the extra field because its
    `shared_vectors_match` enumerates the compared keys explicitly (verified by
    reading that test). The arithmetic below is the mirror; the *shape* is not.
    """

    shares_out: int
    fee: int
    integrator_fee: int
    net: int
    new_reserve_bought: int
    new_reserve_other: int


@dataclass(frozen=True)
class SellQuoteWith:
    """`SellQuote` plus the integrator leg (#24). See `BuyQuoteWith` for why
    this is a separate type."""

    shares_in: int
    fee: int
    integrator_fee: int
    gross: int
    new_reserve_sold: int
    new_reserve_other: int


def calc_buy_with(
    r_bought: int, r_other: int, collateral_in: int, fee_bps: int, integrator_fee_bps: int
) -> BuyQuoteWith:
    """Mirror of math.rs::calc_buy_with. Both fees are rounded **up**, so the
    trader (who opted into the integrator) absorbs the rounding and the pool
    can never be credited less than `net` mints."""
    if collateral_in <= 0 or r_bought <= 0 or r_other <= 0:
        raise MathError("invalid input")
    fee = mul_div_ceil(collateral_in, fee_bps, BPS)
    ifee = mul_div_ceil(collateral_in, integrator_fee_bps, BPS)
    net = collateral_in - fee - ifee
    if net <= 0:
        raise MathError("invalid input")
    new_other = r_other + net
    new_bought = mul_div_ceil(r_bought, r_other, new_other)
    shares_out = r_bought + net - new_bought
    if shares_out <= 0:
        raise MathError("invalid input")
    return BuyQuoteWith(shares_out, fee, ifee, net, new_bought, new_other)


def calc_sell_with(
    r_sold: int, r_other: int, collateral_out: int, fee_bps: int, integrator_fee_bps: int
) -> SellQuoteWith:
    """Mirror of math.rs::calc_sell_with. `gross` is rounded up on the
    **combined** bps, then the integrator leg is rounded **down** out of the
    total spread and the protocol takes the remainder, so the protocol never
    receives less than a protocol-only computation would have given it."""
    sum_fees = fee_bps + integrator_fee_bps
    if collateral_out <= 0 or r_sold <= 0 or r_other <= 0 or sum_fees >= BPS:
        raise MathError("invalid input")
    gross = mul_div_ceil(collateral_out, BPS, BPS - sum_fees)
    total_fee = gross - collateral_out
    if sum_fees == 0:
        # The split would divide by zero; there is no fee to split.
        fee, ifee = 0, 0
    else:
        ifee = mul_div_floor(total_fee, integrator_fee_bps, sum_fees)
        fee = total_fee - ifee
    if gross >= r_other:
        raise MathError("insufficient liquidity")
    new_other = r_other - gross
    new_sold = mul_div_ceil(r_sold, r_other, new_other)
    shares_in = new_sold + gross - r_sold
    if shares_in <= 0:
        raise MathError("invalid input")
    return SellQuoteWith(shares_in, fee, ifee, gross, new_sold, new_other)


def _lcg_stream(seed: int = 0x9E37_79B9_7F4A_7C15):
    """The exact LCG `math.rs`'s integrator property tests use (`PCG` step
    constants over `u64`, shifted right by 33), so Python sweeps the *same*
    inputs as Rust rather than a fresh random sample."""
    x = seed

    def next_int() -> int:
        nonlocal x
        x = (x * 6_364_136_223_846_793_005 + 1_442_695_040_888_963_407) & (2**64 - 1)
        return x >> 33

    return next_int


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


def _check_integrator_known_values():
    """The literal expectations asserted by math.rs's
    `buy_with_integrator_known_values` / `sell_with_integrator_known_values`.
    Transcribed from the Rust source, not recomputed, so an arithmetic
    divergence here shows up as a Python failure."""
    q = calc_buy_with(1000, 1000, 100, 100, 50)
    assert q.fee == 1, q
    assert q.integrator_fee == 1, q
    assert q.net == 98, q
    assert q.shares_out == 187, q
    assert q.new_reserve_bought == 911, q
    assert q.new_reserve_other == 1098, q

    s = calc_sell_with(10_000, 20_000, 1000, 100, 50)
    assert s.gross == 1016, s
    assert s.integrator_fee == 5, s
    assert s.fee == 11, s
    assert s.fee + s.integrator_fee == s.gross - 1000, s
    assert s.new_reserve_other == 18_984, s
    assert s.new_reserve_sold == 10_536, s
    assert s.shares_in == 1552, s


def _check_integrator_accounting_is_exact(trials: int = 2_000):
    """math.rs's `do_buy` / `do_sell` assert these identities on chain:
    `collateral_in == net + fee + ifee` and `gross == collateral_out + fee +
    ifee`. If either broke, `sets_minted` would drift from the collateral the
    contract actually holds, which is the solvency invariant. Swept over the
    Rust LCG inputs so the two languages test the same domain."""
    next_int = _lcg_stream()
    for _ in range(trials):
        ry = 1_000_000 + next_int() % 1_000_000_000
        rn = 1_000_000 + next_int() % 1_000_000_000
        amt = 1 + next_int() % (min(ry, rn) // 2)
        fee = next_int() % 200
        ifee = next_int() % 200
        q = calc_buy_with(ry, rn, amt, fee, ifee)
        assert q.net + q.fee + q.integrator_fee == amt, q
        try:
            s = calc_sell_with(ry, rn, amt, fee, ifee)
        except MathError:
            continue
        assert s.gross == amt + s.fee + s.integrator_fee, s


def _check_calc_buy_with_zero_integrator_matches_calc_buy(trials: int = 2_000):
    next_int = _lcg_stream()
    for _ in range(trials):
        ry = 1_000_000 + next_int() % 1_000_000_000
        rn = 1_000_000 + next_int() % 1_000_000_000
        amt = 1 + next_int() % (min(ry, rn) // 2)
        fee = next_int() % 300
        q1 = calc_buy(ry, rn, amt, fee)
        q2 = calc_buy_with(ry, rn, amt, fee, 0)
        assert (q1.shares_out, q1.fee, q1.net, q1.new_reserve_bought, q1.new_reserve_other) == (
            q2.shares_out,
            q2.fee,
            q2.net,
            q2.new_reserve_bought,
            q2.new_reserve_other,
        ), (q1, q2)
        assert q2.integrator_fee == 0


def _check_calc_sell_with_zero_integrator_matches_calc_sell(trials: int = 2_000):
    next_int = _lcg_stream()
    for _ in range(trials):
        ry = 1_000_000 + next_int() % 1_000_000_000
        rn = 1_000_000 + next_int() % 1_000_000_000
        amt = 1 + next_int() % (rn // 2)
        fee = next_int() % 300
        q1 = calc_sell(ry, rn, amt, fee)
        q2 = calc_sell_with(ry, rn, amt, fee, 0)
        assert (q1.shares_in, q1.fee, q1.gross, q1.new_reserve_sold, q1.new_reserve_other) == (
            q2.shares_in,
            q2.fee,
            q2.gross,
            q2.new_reserve_sold,
            q2.new_reserve_other,
        ), (q1, q2)
        assert q2.integrator_fee == 0


def _check_sell_split_never_shortchanges_protocol(trials: int = 2_000):
    next_int = _lcg_stream()
    for _ in range(trials):
        ry = 1_000_000 + next_int() % 1_000_000_000
        rn = 1_000_000 + next_int() % 1_000_000_000
        amt = 1 + next_int() % (rn // 4)
        fee = next_int() % 200
        ifee = next_int() % 200
        try:
            q_with = calc_sell_with(ry, rn, amt, fee, ifee)
            q_solo = calc_sell(ry, rn, amt, fee)
        except MathError:
            continue
        assert q_with.fee >= q_solo.fee, "protocol shortchanged"
        assert q_with.fee + q_with.integrator_fee == q_with.gross - amt


def _check_round_trip_with_integrator_never_profits(trials: int = 2_000):
    next_int = _lcg_stream()
    for _ in range(trials):
        ry = 1_000_000 + next_int() % 1_000_000_000
        rn = 1_000_000 + next_int() % 1_000_000_000
        amt = 1 + next_int() % (min(ry, rn) // 2)
        fee = next_int() % 200
        ifee = next_int() % 100
        k0 = ry * rn
        q = calc_buy_with(ry, rn, amt, fee, ifee)
        assert q.new_reserve_bought * q.new_reserve_other >= k0
        try:
            s = calc_sell_with(q.new_reserve_bought, q.new_reserve_other, amt, fee, ifee)
        except MathError:
            continue
        assert s.shares_in >= q.shares_out, "free money with integrator"


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


def run_all():
    _check_known_values()
    _check_shared_vectors()
    _check_integrator_known_values()
    _check_integrator_accounting_is_exact()
    _check_calc_buy_with_zero_integrator_matches_calc_buy()
    _check_calc_sell_with_zero_integrator_matches_calc_sell()
    _check_sell_split_never_shortchanges_protocol()
    _check_round_trip_with_integrator_never_profits()
    _check_seed_opens_at_requested_probability()
    _check_k_never_decreases_and_round_trip_never_profits()
    _check_gross_for_shares_inverts_calc_sell()
    _check_void_never_overpays()
    _check_price_after_maps_both_sides()
    _check_limits_boundary_and_symmetry()
    print("fpmm_model: all property checks passed")


if __name__ == "__main__":
    run_all()
