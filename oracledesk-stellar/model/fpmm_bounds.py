"""Executable verification of the theorems in docs/fpmm-economics.md.

Standard library only; imports the exact-integer mirror of math.rs:

    python3 model/fpmm_bounds.py --quick       # CI: exhaustive small + 20k random
    python3 model/fpmm_bounds.py --full        # local: deeper search + 200k random
    python3 model/fpmm_bounds.py --self-test   # prove the search detects bad rounding
    python3 model/fpmm_bounds.py --table       # regenerate the recommendations table

Notation (see the doc): a pool holds reserves (y, n); `M` is the number of
complete sets minted; the seed `S` is the initial `M`. Shares are conserved:
`y + (user yes) + cy == M` and `n + (user no) + cn == M`, where (cy, cn) are the
creator's seed shares. A single trader is modelled; several traders are
equivalent to one that holds all their shares, so it covers the reachable
pool states too.

Every theorem is checked two ways: exhaustively over small reserves
(coverage is printed) and randomly at magnitudes up to MAX_SETS.
"""

import argparse
import os
import random
import sys
import time
from fractions import Fraction
from math import isqrt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fpmm_model as fm  # noqa: E402

BPS = fm.BPS
FEES = (0, 1, 100, 1000)  # bps; 1000 is MAX_FEE_BPS in market-core
USDC = 10_000_000


class Violation(AssertionError):
    pass


def ensure(cond, msg):
    if not cond:
        raise Violation(msg)


# ---------------------------------------------------------------------------
# Single-trader transition system. State of the pool+trader:
#   (y, n, hy, hn) with `profit` (= collateral out - collateral in) carried
# alongside as a value so dominated paths can be pruned.
# ---------------------------------------------------------------------------


def apply_buy(st, yes, amt, fee):
    y, n, hy, hn, profit = st
    rb, ro = (y, n) if yes else (n, y)
    try:
        q = fm.calc_buy(rb, ro, amt, fee)
    except fm.MathError:
        return None
    if yes:
        return (q.new_reserve_bought, q.new_reserve_other, hy + q.shares_out, hn, profit - amt)
    return (q.new_reserve_other, q.new_reserve_bought, hy, hn + q.shares_out, profit - amt)


def apply_sell(st, yes, out, fee):
    y, n, hy, hn, profit = st
    rs, ro = (y, n) if yes else (n, y)
    try:
        q = fm.calc_sell(rs, ro, out, fee)
    except fm.MathError:
        return None
    if q.shares_in > (hy if yes else hn):
        return None
    if yes:
        return (q.new_reserve_sold, q.new_reserve_other, hy - q.shares_in, hn, profit + out)
    return (q.new_reserve_other, q.new_reserve_sold, hy, hn - q.shares_in, profit + out)


def check_no_risk_free_profit(y0, n0, st, where):
    """Theorem 2 (strong form). With A = max(y - y0, n - n0):
        guaranteed payoff  min(P_yes, P_no) = profit + min(hy, hn) <= -A <= 0
    where profit = collateral out - collateral in. It also pins the share
    bookkeeping: hy = dM - (y - y0), hn = dM - (n - n0) with dM = M - S."""
    y, n, hy, hn, profit = st
    a = max(y - y0, n - n0)
    ensure(a >= 0, f"{where}: both reserves below seed (k fell) {st}")
    ensure(profit + min(hy, hn) <= -a, f"{where}: risk-free profit {st} y0={y0} n0={n0}")
    ensure((hy + (y - y0)) == (hn + (n - n0)), f"{where}: share conservation {st}")
    # Void pays floor((hy+hn)/2) >= min(hy, hn), so it cannot rescue the claim.
    ensure(profit + (hy + hn) // 2 >= profit + min(hy, hn), where)


# ---------------------------------------------------------------------------
# 1. Exhaustive no-arbitrage / round trips
# ---------------------------------------------------------------------------


def exhaustive_round_trips(starts, fees=FEES, amounts=range(1, 11), max_ops=3):
    """BFS over every buy/sell sequence (<= max_ops operations, collateral
    amounts drawn from `amounts`) from each starting pool. Per
    (y, n, hy, hn) only the maximum profit is kept: continuations depend on
    nothing else, and a state first reached at an earlier depth with at least
    the same profit dominates a later arrival, so pruning loses no sequence."""
    visited = 0
    flat_states = 0
    for (y0, n0) in starts:
        for fee in fees:
            best = {(y0, n0, 0, 0): 0}
            frontier = dict(best)
            for _ in range(max_ops):
                nxt = {}
                for (y, n, hy, hn), profit in frontier.items():
                    st = (y, n, hy, hn, profit)
                    for yes in (True, False):
                        for a in amounts:
                            for ns in (apply_buy(st, yes, a, fee), apply_sell(st, yes, a, fee)):
                                if ns is None:
                                    continue
                                key, p = ns[:4], ns[4]
                                if p > nxt.get(key, -(10**30)):
                                    nxt[key] = p
                frontier = {}
                for key, p in nxt.items():
                    if p > best.get(key, -(10**30)):
                        best[key] = p
                        frontier[key] = p
                        visited += 1
                        check_no_risk_free_profit(y0, n0, key + (p,), f"start=({y0},{n0}) fee={fee}")
                        if key[2] == 0 and key[3] == 0:
                            flat_states += 1
                            ensure(p <= 0, f"flat round trip profits: {key} {p}")
                if not frontier:
                    break
    return visited, flat_states


def default_starts(max_reserve):
    starts = set()
    for s in (12, 30, max_reserve):
        for p in (100, 1000, 5000, 9000, 9900):
            try:
                r = fm.seed_reserves(s, p)
            except fm.MathError:
                continue
            starts.add((r.reserve_yes, r.reserve_no))
    for y, n in ((1, 1), (2, 7), (7, 2), (max_reserve, 1), (1, max_reserve), (max_reserve, max_reserve)):
        starts.add((y, n))
    return sorted(starts)


# ---------------------------------------------------------------------------
# 2. LP worst case (exhaustive)
# ---------------------------------------------------------------------------


def lp_payouts(seed, yes_bps, y, n):
    s = fm.seed_reserves(seed, yes_bps)
    pay_yes = s.creator_yes + y
    pay_no = s.creator_no + n
    # Two separate floors: the pool's claim and the creator's own redeem().
    pay_void = fm.settle_value("void", y, n) + fm.settle_value("void", s.creator_yes, s.creator_no)
    return pay_yes, pay_no, pay_void


def check_lp_state(seed, yes_bps, s0, y, n):
    k0 = s0.reserve_yes * s0.reserve_no
    ensure(y >= 1 and n >= 1, f"reserve hit zero ({y},{n})")
    ensure(y * n >= k0, f"k fell ({y},{n}) < {k0}")
    pay_yes, pay_no, pay_void = lp_payouts(seed, yes_bps, y, n)
    # Exact identities: the LP's loss under an outcome is the fall of that
    # outcome's pool reserve (the creator's seed shares make up the rest).
    ensure(seed - pay_yes == s0.reserve_yes - y, "loss_yes identity")
    ensure(seed - pay_no == s0.reserve_no - n, "loss_no identity")
    # Reserve floor from k: the winner's reserve cannot fall below ceil(k0/other).
    ensure(y >= -(-k0 // n) and n >= -(-k0 // y), "k floor")
    # Void: AM-GM gives y + n >= ceil(2 sqrt(k0)); two floors cost <= 1 unit.
    amgm = isqrt(4 * k0 - 1) + 1 if k0 > 0 else 0  # smallest s with s*s >= 4*k0
    cvoid = s0.creator_yes + s0.creator_no
    ensure(pay_void >= amgm // 2 + cvoid // 2, "void AM-GM bound")
    ensure(2 * (pay_void + 1) >= seed, f"void payout below S/2 - 1: {pay_void} seed={seed}")
    return pay_yes, pay_no, pay_void


def lp_worst_case_exhaustive(seeds=(150, 400), yes_bps_list=(100, 1000, 5000, 9000, 9900), fees=FEES,
                             amounts=(1, 2, 3, 5, 8, 13, 21, 34, 55), depth=3):
    """Enumerate every reachable pool state up to `depth` trades and compare
    the minimum LP payout per outcome against the closed forms."""
    states = 0
    worst = {}
    for seed in seeds:
        for p in yes_bps_list:
            s0 = fm.seed_reserves(seed, p)
            for fee in fees:
                seen = {(s0.reserve_yes, s0.reserve_no, 0, 0)}
                frontier = set(seen)
                lo = [10**30] * 3
                for _ in range(depth + 1):
                    nxt = set()
                    for (y, n, hy, hn) in frontier:
                        pays = check_lp_state(seed, p, s0, y, n)
                        lo = [min(a, b) for a, b in zip(lo, pays)]
                        for yes in (True, False):
                            for a in amounts:
                                st = (y, n, hy, hn, 0)
                                for ns in (apply_buy(st, yes, a, fee), apply_sell(st, yes, a, fee)):
                                    if ns is not None and ns[:4] not in seen:
                                        seen.add(ns[:4])
                                        nxt.add(ns[:4])
                    frontier = nxt
                states += len(seen)
                worst[(seed, p, fee)] = tuple(lo)
    return states, worst


# ---------------------------------------------------------------------------
# 3. Rounding is conservative (one-step dominance vs the exact-real model)
# ---------------------------------------------------------------------------


def check_one_step_dominance(rb, ro, amt, fee):
    f = Fraction(fee, BPS)
    try:
        q = fm.calc_buy(rb, ro, amt, fee)
    except fm.MathError:
        return False
    net_real = Fraction(amt) * (1 - f)  # real fee; integer fee is ceil'd, so net <= net_real
    ensure(q.net <= net_real, "ceil(fee) must not under-charge")
    cont_bought = Fraction(rb * ro, ro + q.net)  # continuous pool at the SAME integer net
    ensure(q.new_reserve_bought >= cont_bought, "buy: pool keeps less than continuous")
    ensure(q.shares_out <= rb + q.net - cont_bought, "buy: trader gets more than continuous")
    ensure(q.new_reserve_bought * q.new_reserve_other >= rb * ro, "buy: k fell")
    return True


def check_one_step_dominance_sell(rs, ro, out, fee):
    try:
        q = fm.calc_sell(rs, ro, out, fee)
    except fm.MathError:
        return False
    g_real = Fraction(out * BPS, BPS - fee)
    ensure(q.gross >= g_real, "ceil(gross) must not under-burn")
    # Continuous shares_in is increasing in gross, so the integer (larger
    # gross, then ceil'd new_sold) can only cost the seller more.
    cont_in = Fraction(rs * ro, ro - q.gross) + q.gross - rs
    ensure(q.shares_in >= cont_in, "sell: seller pays less than continuous")
    ensure(q.new_reserve_sold * q.new_reserve_other >= rs * ro, "sell: k fell")
    return True


# ---------------------------------------------------------------------------
# 4. Path splitting
# ---------------------------------------------------------------------------


def check_path_splitting(rb, ro, parts, fee):
    """Splitting `sum(parts)` of collateral into sequential buys of the same
    outcome never yields more shares than one buy of the total."""
    total = sum(parts)
    try:
        single = fm.calc_buy(rb, ro, total, fee).shares_out
    except fm.MathError:
        return False
    got, b, o = 0, rb, ro
    for c in parts:
        try:
            q = fm.calc_buy(b, o, c, fee)
        except fm.MathError:
            return True  # a part too small to buy anything: trader gets 0 for it
        got += q.shares_out
        b, o = q.new_reserve_bought, q.new_reserve_other
    ensure(got <= single, f"split buys beat single: {got} > {single} ({rb},{ro},{parts},{fee})")
    return True


def exhaustive_path_splitting(max_total=40):
    n = 0
    for fee in FEES:
        for rb in (3, 10, 50):
            for ro in (3, 10, 50):
                for total in range(2, max_total):
                    for first in range(1, total):
                        if check_path_splitting(rb, ro, [first, total - first], fee):
                            n += 1
    return n


# ---------------------------------------------------------------------------
# 5. Randomized checks at production magnitudes
# ---------------------------------------------------------------------------


def randomized_large(n=200_000, seed=2026):
    rng = random.Random(seed)
    runs = ops = 0
    while ops < n:
        s = rng.randint(100 * USDC, fm.MAX_SETS // 4)
        p = rng.choice((100, 500, 2500, 5000, 7500, 9500, 9900, rng.randint(100, 9900)))
        fee = rng.choice((0, 1, 30, 100, 300, 1000, rng.randint(0, 1000)))
        s0 = fm.seed_reserves(s, p)
        st = (s0.reserve_yes, s0.reserve_no, 0, 0, 0)
        runs += 1
        for _ in range(rng.randint(3, 30)):
            yes = rng.random() < 0.5
            ry, rn = st[0], st[1]
            rb, ro = (ry, rn) if yes else (rn, ry)
            ops += 1
            if rng.random() < 0.6:
                amt = rng.randint(1, max(1, min(fm.MAX_SETS // 8, 10 ** rng.randint(2, 15))))
                check_one_step_dominance(rb, ro, amt, fee)
                ns = apply_buy(st, yes, amt, fee)
                if ns and ns[0] + ns[1] + ns[2] + ns[3] < fm.MAX_SETS * 4:
                    st = ns
            else:
                out = rng.randint(1, max(1, ro // rng.choice((2, 10, 1000))))
                check_one_step_dominance_sell(rb, ro, out, fee)
                ns = apply_sell(st, yes, out, fee)
                if ns:
                    st = ns
            check_no_risk_free_profit(s0.reserve_yes, s0.reserve_no, st, f"random run {runs}")
            check_lp_state(s, p, s0, st[0], st[1])
        parts = [rng.randint(1, 10 ** rng.randint(3, 13)) for _ in range(rng.randint(2, 6))]
        check_path_splitting(s0.reserve_yes, s0.reserve_no, parts, fee)
    return runs, ops


# ---------------------------------------------------------------------------
# 6. Void dust
# ---------------------------------------------------------------------------


def void_dust_bound(trials=20_000, seed=5):
    """Dust left in the contract after every holder redeems a void market.
    Shares of each outcome sum to M, payouts are floor((a_i+b_i)/2) per
    recipient (holders, the creator, and the pool), so
        dust = M - sum floor((a_i+b_i)/2) = (#recipients with odd a_i+b_i)/2
    <= floor(H/2) for H recipients. Returns the worst dust observed per H."""
    rng = random.Random(seed)
    worst = {}
    for _ in range(trials):
        h = rng.randint(1, 40)
        m = rng.randint(h, 10_000)
        # random allocations of the M yes shares and M no shares over h recipients
        def split(total):
            cuts = sorted(rng.randint(0, total) for _ in range(h - 1))
            return [b - a for a, b in zip([0] + cuts, cuts + [total])]

        ys, ns = split(m), split(m)
        paid = sum((a + b) // 2 for a, b in zip(ys, ns))
        dust = m - paid
        odd = sum((a + b) % 2 for a, b in zip(ys, ns))
        ensure(dust * 2 == odd, "dust identity")
        ensure(dust <= h // 2, f"dust {dust} > H/2 for H={h}")
        worst[h] = max(worst.get(h, 0), dust)
    return worst


# ---------------------------------------------------------------------------
# Self-test: break the rounding rule and make sure the search notices
# ---------------------------------------------------------------------------


def self_test():
    real = fm.calc_buy

    def floor_buy(r_bought, r_other, collateral_in, fee_bps):
        # Deliberately wrong: new_bought rounds DOWN, so the trader gets one
        # extra share per trade and k can fall.
        if collateral_in <= 0 or r_bought <= 0 or r_other <= 0:
            raise fm.MathError("invalid input")
        fee = fm.mul_div_ceil(collateral_in, fee_bps, BPS)
        net = collateral_in - fee
        if net <= 0:
            raise fm.MathError("invalid input")
        new_other = r_other + net
        new_bought = fm.mul_div_floor(r_bought, r_other, new_other)
        shares_out = r_bought + net - new_bought
        if shares_out <= 0 or new_bought <= 0:
            raise fm.MathError("invalid input")
        return fm.BuyQuote(shares_out, fee, net, new_bought, new_other)

    fm.calc_buy = floor_buy
    try:
        try:
            exhaustive_round_trips(default_starts(30), fees=(0,), amounts=range(1, 8), max_ops=3)
        except Violation as e:
            return str(e)
        raise SystemExit("SELF-TEST FAILED: floor-rounded calc_buy was not detected")
    finally:
        fm.calc_buy = real


# ---------------------------------------------------------------------------
# Recommendations table (exact integer simulation)
# ---------------------------------------------------------------------------


def adverse_scenario(seed, p0, fee, target_bps):
    """A whale buys outcome `o` until its price reaches `target_bps`, then `o`
    wins. Returns, for the worse of o in {yes, no}: (LP loss, whale volume,
    LP fee income if the LP kept 100% of fees). LP loss excludes fee income."""
    s0 = fm.seed_reserves(seed, p0)
    best = (0, 0, 0)
    for yes in (True, False):
        rb, ro = (s0.reserve_yes, s0.reserve_no) if yes else (s0.reserve_no, s0.reserve_yes)

        def price(c):
            q = fm.calc_buy(rb, ro, c, fee)
            return fm.mul_div_floor(q.new_reserve_other, BPS, q.new_reserve_bought + q.new_reserve_other), q

        if fm.mul_div_floor(ro, BPS, rb + ro) >= target_bps:
            continue
        lo, hi = 1, fm.MAX_SETS
        while lo < hi:
            mid = (lo + hi) // 2
            try:
                ok = price(mid)[0] >= target_bps
            except fm.MathError:
                ok = False
            if ok:
                hi = mid
            else:
                lo = mid + 1
        try:
            _, q = price(lo)
        except fm.MathError:
            continue
        loss = rb - q.new_reserve_bought
        if loss > best[0]:
            best = (loss, lo, q.fee)
    return best


def recommendation_table():
    rows = []
    print("| S (USDC) | p0 | fee bps | whale volume to reach 99% | LP loss if that side wins | loss / S | LP fees @100% share | net loss / S |")
    print("|---|---|---|---|---|---|---|---|")
    for s_usdc in (100, 200, 500):
        for p0 in (100, 1000, 5000, 9000, 9900):
            for fee in (0, 50, 100, 300):
                loss, vol, fees = adverse_scenario(s_usdc * USDC, p0, fee, 9900)
                if vol == 0:
                    continue
                rows.append((s_usdc, p0, fee, vol, loss, fees))
                S = s_usdc * USDC
                print(f"| {s_usdc} | {p0/BPS:.2f} | {fee} | {vol / USDC:,.1f} | {loss / USDC:,.2f} | "
                      f"{loss / S:.1%} | {fees / USDC:,.2f} | {(loss - fees) / S:.1%} |")
    return rows


# ---------------------------------------------------------------------------


def run(mode):
    quick = mode == "quick"
    t0 = time.time()

    def stage(name, fn):
        t = time.time()
        res = fn()
        print(f"  ok  {name}: {res}  ({time.time() - t:.1f}s)")

    print(f"fpmm_bounds [{mode}]")
    starts = default_starts(60)
    ops = 3 if quick else 4
    amts = range(1, 11) if quick else range(1, 15)

    def a():
        v, f = exhaustive_round_trips(starts, amounts=amts, max_ops=ops)
        return f"{len(starts)} pools x {len(FEES)} fees, <= {ops} ops: {v:,} states ({f:,} flat), no risk-free profit"

    stage("T2 no risk-free profit / flat round trips (exhaustive)", a)

    def b():
        st, w = lp_worst_case_exhaustive(depth=3 if quick else 4)
        mins = min(v[0] for v in w.values()), min(v[1] for v in w.values())
        return f"{st:,} reachable pool states over {len(w)} (S,p0,fee) configs; identities + bounds hold"

    stage("T1/T3/T4 LP identities, floors and Void bound (exhaustive)", b)
    stage("T5 path splitting (exhaustive, two-way splits)", lambda: f"{exhaustive_path_splitting(25 if quick else 40):,} cases")

    def c():
        runs, nops = randomized_large(50_000 if quick else 200_000)
        return f"{runs:,} runs / {nops:,} ops up to MAX_SETS: dominance, k, T2, LP, T5 hold"

    stage("randomized, production magnitudes", c)
    stage("void dust <= floor(H/2)", lambda: f"{len(void_dust_bound())} holder counts, bound tight")
    stage("self-test (floor-rounded calc_buy must be caught)", lambda: "caught: " + self_test()[:70])
    print(f"all fpmm_bounds checks passed in {time.time() - t0:.1f}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--quick", action="store_true", help="CI mode (default), < 60s")
    g.add_argument("--full", action="store_true", help="deeper local run")
    g.add_argument("--self-test", action="store_true", help="show the search catches broken rounding")
    g.add_argument("--table", action="store_true", help="print the recommendations table")
    args = ap.parse_args()
    if args.self_test:
        print("detected:", self_test())
    elif args.table:
        recommendation_table()
    else:
        run("full" if args.full else "quick")


if __name__ == "__main__":
    main()
