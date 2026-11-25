//! Kani harnesses for the FPMM pricing engine and settlement ledger.
//!
//! These harnesses are compiled only under `cfg(kani)`: `cargo test`,
//! `cargo build` and Clippy never see them. Run them with
//!
//! ```text
//! cargo kani -p market-core
//! ```
//!
//! Every `kani::assume` below mirrors a check in `contracts/market-core/src/lib.rs`
//! (the file/function is named in the comment). Narrowing the domain without a
//! matching contract check would make the proofs vacuous, so keep the two in
//! sync. See `docs/formal-verification.md` for the property table, assumptions
//! and known gaps.

use crate::math::{
    apply_pool_claim, apply_redeem, batch_redeem_step, calc_buy, calc_sell, finalize_residual,
    finalize_sweep, mul_div_ceil, mul_div_floor, price_yes_bps, seed_reserves, settle_upper,
    settle_value, SettleLedger, Settlement, BPS, MAX_PROB_BPS, MAX_SETS, MIN_PROB_BPS,
};
use kani::assume;

/// `MAX_FEE_BPS` in `contracts/market-core/src/lib.rs`; enforced by
/// `__constructor` and `set_default_fee_bps`.
const CONTRACT_MAX_FEE_BPS: u32 = 1_000;
/// `MIN_SEED` in `contracts/market-core/src/lib.rs`; enforced by
/// `create_market`.
const CONTRACT_MIN_SEED: i128 = 100 * 10_000_000;

/// Reserves are positive and bounded by `MAX_SETS`. `create_market` enforces
/// the seed range; trading preserves the bound because `buy` rejects
/// `sets_minted + net > MAX_SETS`.
fn assume_reserve(r: i128) {
    assume(r > 0);
    assume(r <= MAX_SETS);
}

/// `buy` rejects a fee above `MAX_FEE_BPS`. `calc_sell` itself accepts a
/// wider domain (any fee `< BPS`) but the contract never passes one.
fn assume_contract_fee(fee_bps: u32) {
    assume(fee_bps <= CONTRACT_MAX_FEE_BPS);
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_floor_bounds() {
    // The lemma layer: a, b ∈ [0, MAX_SETS] and c ∈ [1, 2*MAX_SETS] cover
    // every call site (reserve sums are at most 2*MAX_SETS).
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume(a >= 0 && a <= MAX_SETS);
    assume(b >= 0 && b <= MAX_SETS);
    assume(c >= 1 && c <= 2 * MAX_SETS);

    let q = mul_div_floor(a, b, c).expect("product fits: 1e15 * 1e15 << i128::MAX");
    let p = a * b; // bounded by 1e30
    let qc = q * c; // q = floor(p/c), so q*c <= p <= 1e30
    assert!(qc <= p);
    assert!(p - qc < c);
    kani::cover!(p - qc > 0, "division leaves a remainder");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_ceil_bounds() {
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume(a >= 0 && a <= MAX_SETS);
    assume(b >= 0 && b <= MAX_SETS);
    assume(c >= 1 && c <= 2 * MAX_SETS);

    let q = mul_div_ceil(a, b, c).expect("product fits: 1e15 * 1e15 << i128::MAX");
    let p = a * b;
    let qc = q * c; // <= p + c - 1 <= 1e30 + 2e15
    assert!(qc >= p);
    assert!(qc - p < c);
    if p % c == 0 {
        assert!(q == p / c);
    }
    kani::cover!(qc > p, "ceil rounds up");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_rejects_invalid_inputs() {
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume(a < 0 || b < 0 || c <= 0);
    assert!(mul_div_floor(a, b, c).is_err());
    assert!(mul_div_ceil(a, b, c).is_err());
    kani::cover!(a >= 0 && b >= 0 && c == 0, "zero divisor alone is rejected");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_calc_buy_no_panic_and_positive_shares() {
    let r_bought: i128 = kani::any();
    let r_other: i128 = kani::any();
    let collateral_in: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_bought);
    assume_reserve(r_other);
    assume(collateral_in > 0 && collateral_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    let q = match calc_buy(r_bought, r_other, collateral_in, fee_bps) {
        Ok(q) => q,
        Err(_) => return,
    };
    // Success must mean a usable quote: no panic on any path, strictly
    // positive shares, and the fee/nets split conserves collateral.
    assert!(q.shares_out > 0);
    assert!(q.fee >= 0);
    assert!(q.net > 0);
    assert!(q.net + q.fee == collateral_in);
    assert!(q.new_reserve_other >= r_other);
    assert!(q.new_reserve_bought > 0);
    kani::cover!(q.fee > 0, "a fee-paying buy succeeds");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_calc_buy_k_monotone() {
    let r_bought: i128 = kani::any();
    let r_other: i128 = kani::any();
    let collateral_in: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_bought);
    assume_reserve(r_other);
    assume(collateral_in > 0 && collateral_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_buy(r_bought, r_other, collateral_in, fee_bps) {
        // Both products are <= 2e30, well inside i128.
        let k_before = r_bought * r_other;
        let k_after = q.new_reserve_bought * q.new_reserve_other;
        assert!(k_after >= k_before, "buy must never decrease k");
        kani::cover!(k_after > k_before, "rounding grows k");
    }
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_calc_sell_no_panic_and_positive_shares() {
    let r_sold: i128 = kani::any();
    let r_other: i128 = kani::any();
    let collateral_out: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_sold);
    assume_reserve(r_other);
    assume(collateral_out > 0 && collateral_out <= MAX_SETS);
    assume_contract_fee(fee_bps);

    let q = match calc_sell(r_sold, r_other, collateral_out, fee_bps) {
        Ok(q) => q,
        Err(_) => return,
    };
    assert!(q.shares_in > 0);
    assert!(q.gross > 0);
    assert!(q.gross >= collateral_out);
    assert!(q.fee >= 0);
    assert!(q.gross - q.fee == collateral_out);
    assert!(q.new_reserve_other > 0);
    assert!(q.new_reserve_sold > 0);
    kani::cover!(q.fee > 0, "a fee-paying sell succeeds");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_calc_sell_k_monotone() {
    let r_sold: i128 = kani::any();
    let r_other: i128 = kani::any();
    let collateral_out: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_sold);
    assume_reserve(r_other);
    assume(collateral_out > 0 && collateral_out <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_sell(r_sold, r_other, collateral_out, fee_bps) {
        let k_before = r_sold * r_other;
        let k_after = q.new_reserve_sold * q.new_reserve_other;
        assert!(k_after >= k_before, "sell must never decrease k");
        kani::cover!(k_after > k_before, "rounding grows k");
    }
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_hi_price() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume(seed >= CONTRACT_MIN_SEED && seed <= MAX_SETS);
    assume(p >= 5_000 && p >= MIN_PROB_BPS && p <= MAX_PROB_BPS);
    let s = seed_reserves(seed, p).expect("in-domain seed");
    let price = price_yes_bps(s.reserve_yes, s.reserve_no).expect("positive reserves");
    assert!((price - p as i128).abs() <= 1);
    // p >= 5000 keeps all `seed` in the NO reserve, so the creator keeps
    // only YES shares (none at exactly 5000, where both are zero).
    assert_eq!(s.reserve_no, seed);
    assert_eq!(s.creator_no, 0);
    assert!(s.creator_yes >= 0);
    kani::cover!(s.creator_yes > 0, "creator keeps YES shares");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_lo_price() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume(seed >= CONTRACT_MIN_SEED && seed <= MAX_SETS);
    assume(p >= MIN_PROB_BPS && p < 5_000);
    let s = seed_reserves(seed, p).expect("in-domain seed");
    let price = price_yes_bps(s.reserve_yes, s.reserve_no).expect("positive reserves");
    assert!((price - p as i128).abs() <= 1);
    // p < 5000 keeps all `seed` in the YES reserve, so the creator keeps
    // only NO shares.
    assert_eq!(s.reserve_yes, seed);
    assert_eq!(s.creator_yes, 0);
    assert!(s.creator_no >= 0);
    kani::cover!(s.creator_no > 0, "creator keeps NO shares");
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_rejects_out_of_domain() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume(seed <= 0 || p < MIN_PROB_BPS || p > MAX_PROB_BPS);
    assert!(seed_reserves(seed, p).is_err());
    kani::cover!(seed > 0, "a valid seed with an invalid price is rejected");
}

/// Buying and immediately selling the same collateral must never return more
/// shares than the buy paid out. If the sell leg fails (for example because
/// the pool cannot pay the requested collateral), the round trip is simply
/// unavailable and the property is vacuous.
#[kani::proof]
#[kani::unwind(1)]
fn proof_round_trip_no_profit() {
    let r_bought: i128 = kani::any();
    let r_other: i128 = kani::any();
    let collateral_in: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_bought);
    assume_reserve(r_other);
    assume(collateral_in > 0 && collateral_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    let buy = match calc_buy(r_bought, r_other, collateral_in, fee_bps) {
        Ok(q) => q,
        Err(_) => return,
    };
    if let Ok(sell) = calc_sell(
        buy.new_reserve_bought,
        buy.new_reserve_other,
        collateral_in,
        fee_bps,
    ) {
        assert!(
            sell.shares_in >= buy.shares_out,
            "round trip must not profit"
        );
        kani::cover!(true, "the sell leg of the round trip is reachable");
    }
}

/// The spot price uses BPS and floors; it is only defined for a positive
/// reserve sum.
#[kani::proof]
#[kani::unwind(1)]
fn proof_price_yes_bps_bounds() {
    let r_yes: i128 = kani::any();
    let r_no: i128 = kani::any();
    assume_reserve(r_yes);
    assume_reserve(r_no);
    let price = price_yes_bps(r_yes, r_no).expect("sum is positive");
    assert!((0..=BPS).contains(&price));
    kani::cover!(price == BPS / 2, "balanced pool prices at 50%");
}

// ---------------------------------------------------------------------------
// Settlement (issue #276)
//
// Harness names start with `proof_settle` so CI can run them as their own
// matrix job (`--harness proof_settle`). Every `assume` names the lib.rs
// check that makes it reachable; every harness has a `kani::cover!` so a
// vacuous proof shows up as an UNSATISFIED cover instead of a green check.
//
// Domain: every share count is bounded by `sets_minted <= MAX_SETS`, which
// `buy` enforces (`sets_minted + net > MAX_SETS` is rejected) and nothing
// else increases. Outstanding shares, reserves and positions are each a
// slice of `sets_minted` per side, so they share the bound. LP fees are
// bounded by the total fees ever charged, which are <= MAX_FEE_BPS of the
// collateral ever traded; `MAX_SETS` is a generous stand-in for that bound
// (the harnesses only add fees, never multiply them).
// ---------------------------------------------------------------------------

/// Symbolic outcome. `lib.rs` `settlement()` maps `Resolved(Yes)`,
/// `Resolved(No)` and `Void` to the three variants and rejects `Open`.
fn any_settlement() -> Settlement {
    let k: u8 = kani::any();
    assume(k < 3);
    match k {
        0 => Settlement::Yes,
        1 => Settlement::No,
        _ => Settlement::Void,
    }
}

/// Share bound for the H = 2 and H = 3 conservation harnesses (see
/// `settlement_conserves`).
const SMALL_BOUND: i128 = 1 << 10;

/// A share count in `[0, MAX_SETS]` (see the domain note above).
fn any_shares() -> i128 {
    let v: i128 = kani::any();
    assume((0..=MAX_SETS).contains(&v));
    v
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_settle_value_no_overflow() {
    // Positions and reserves are non-negative and <= MAX_SETS
    // (`buy` caps `sets_minted`; `sell`/`merge` reject over-spending).
    let kind = any_settlement();
    let yes = any_shares();
    let no = any_shares();
    let v = settle_value(kind, yes, no).expect("in-domain inputs never overflow");
    assert!(v >= 0);
    match kind {
        Settlement::Yes => assert!(v == yes && v <= yes.max(no)),
        Settlement::No => assert!(v == no && v <= yes.max(no)),
        Settlement::Void => {
            assert!(v == (yes + no) / 2);
            assert!(2 * v <= yes + no && yes + no - 2 * v <= 1);
        }
    }
    kani::cover!(
        kind == Settlement::Void && (yes + no) % 2 == 1,
        "odd void claim floors"
    );
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_void_floor_superadditive() {
    // Two holders' positions on the same market; per side they add up to at
    // most the outstanding shares, which are <= sets_minted <= MAX_SETS
    // (`buy` cap). That is the only assume beyond non-negativity.
    let (a1, b1, a2, b2) = (any_shares(), any_shares(), any_shares(), any_shares());
    assume(a1 + a2 <= MAX_SETS);
    assume(b1 + b2 <= MAX_SETS);
    let lhs = settle_value(Settlement::Void, a1, b1).unwrap()
        + settle_value(Settlement::Void, a2, b2).unwrap();
    let rhs = settle_upper(Settlement::Void, a1 + a2, b1 + b2).unwrap();
    assert!(
        lhs <= rhs,
        "per-holder floors never exceed the aggregate floor"
    );
    assert!(rhs - lhs <= 1, "and give back at most one unit");
    kani::cover!(rhs - lhs == 1, "two odd claims lose one unit");
}

#[kani::proof]
#[kani::unwind(4)]
fn proof_settle_upper_over_reserve_bound() {
    // H = 3 holders. Same bound as above: per side, the holders' shares sum
    // to the outstanding count, <= sets_minted <= MAX_SETS (`buy` cap).
    const H: usize = 3;
    let kind = any_settlement();
    let mut sum_y: i128 = 0;
    let mut sum_n: i128 = 0;
    let mut paid: i128 = 0;
    for _ in 0..H {
        let (y, n) = (any_shares(), any_shares());
        sum_y += y;
        sum_n += n;
        assume(sum_y <= MAX_SETS && sum_n <= MAX_SETS);
        paid += settle_value(kind, y, n).unwrap();
    }
    let reserve = settle_upper(kind, sum_y, sum_n).unwrap();
    let gap = reserve - paid;
    assert!(gap >= 0, "settle_upper never under-reserves");
    assert!(gap <= (H as i128) / 2, "over-reserves by at most H/2 units");
    if kind != Settlement::Void {
        assert!(gap == 0, "exact for Yes/No");
    }
    kani::cover!(gap == (H as i128) / 2, "the H/2 bound is tight");
}

/// Shared body of `proof_settlement_conserves_n{1,2,3}`.
///
/// Starts from a final market right after `resolve` / `void_market` (nothing
/// paid yet, so the share invariant of `debug_assert_share_invariant`
/// holds: `reserve_side + Σ position_side == sets_minted`), then applies a
/// symbolic interleaving of any subset of `H` holder redemptions and the
/// LP's pool claim, and finally `finalize_residual` / `finalize_sweep`.
fn settlement_conserves<const H: usize>(bound: i128) {
    let kind = any_settlement();
    // Reserves and positions: non-negative, <= `bound`. `bound == MAX_SETS`
    // (the `buy` cap) for H = 1; H = 2, 3 use a smaller bound because the
    // symbolic-interleaving state space is otherwise intractable (n1 alone
    // takes ~250 s). That loses nothing: the settlement functions only add,
    // subtract and halve, so no property depends on magnitude except
    // overflow, which `proof_settle_value_no_overflow` and
    // `proof_settlement_step_preserves_bound` prove at the full MAX_SETS.
    let any_b = || {
        let v: i128 = kani::any();
        assume((0..=bound).contains(&v));
        v
    };
    let reserve_yes = any_b();
    let reserve_no = any_b();
    let mut yes = [0i128; H];
    let mut no = [0i128; H];
    let mut sum_y = reserve_yes;
    let mut sum_n = reserve_no;
    for i in 0..H {
        yes[i] = any_b();
        no[i] = any_b();
        sum_y += yes[i];
        sum_n += no[i];
    }
    // Share invariant: every complete set is one YES and one NO, either in
    // the pool or held (create_market / buy / sell / split / merge keep it;
    // `debug_assert_share_invariant`, test `share_invariant_holds_*`).
    assume(sum_y == sum_n);
    let sets_minted = sum_y;
    assume(sets_minted <= bound);
    // LP fees accrue outside `sets_minted` (`accrue_fees`).
    let lp_fees = any_b();
    // Protocol fees (`fees_accrued`), also outside `sets_minted`.
    let fees_accrued = any_b();

    let mut l = SettleLedger {
        sets_minted,
        outstanding_yes: sets_minted - reserve_yes,
        outstanding_no: sets_minted - reserve_no,
        reserve_yes,
        reserve_no,
        paid_out: 0,
        fees_paid: 0,
        lp_fees,
        lp_claimed: false,
        tracked: true,
    };

    let mut redeemed = [false; H];
    let mut lp_done = false;
    let mut holder_legs: i128 = 0;
    let mut total_out: i128 = 0;
    // H + 1 steps, each a symbolic choice: a holder (0..H), the LP claim
    // (H) or nothing (anything else). Repeats are no-ops, mirroring
    // `NothingToRedeem` / `AlreadyClaimed` in lib.rs, so this covers every
    // ordering of every subset of the H + 1 legs.
    for _ in 0..(H + 1) {
        let choice = kani::any::<u8>() as usize;
        if choice < H {
            if !redeemed[choice] {
                redeemed[choice] = true;
                holder_legs += 1;
                total_out += apply_redeem(&mut l, kind, yes[choice], no[choice])
                    .expect("in-domain redeem never fails");
            }
        } else if choice == H && !lp_done {
            lp_done = true;
            total_out += apply_pool_claim(&mut l, kind).expect("first pool claim never fails");
        }
        // Payouts never exceed what backs them, at every intermediate step.
        assert!(l.paid_out <= l.sets_minted, "share payouts <= sets_minted");
        assert!(l.fees_paid <= lp_fees, "fee payouts <= LP fees accrued");
        assert!(total_out == l.paid_out + l.fees_paid);
        assert!(l.outstanding_yes >= 0 && l.outstanding_no >= 0);
    }

    let residual = finalize_residual(&l, kind).expect("finalize residual is never negative");
    let (_unclaimed, _lp_claim, dust) = residual;
    // H counts the redeeming holders plus the LP leg (claimed or reserved).
    let legs = holder_legs + 1;
    assert!(dust >= 0);
    assert!(dust <= (legs + 1) / 2, "void dust <= (H + 1) / 2");
    if kind != Settlement::Void {
        assert!(dust == 0, "Yes/No settle exactly");
    }
    // Fee legs are counted exactly once: everything that ever left plus the
    // sweep equals everything that ever came in.
    let swept = finalize_sweep(&l, residual, fees_accrued).expect("sweep fits");
    assert!(l.paid_out + l.fees_paid + swept == sets_minted + lp_fees + fees_accrued);

    kani::cover!(
        kind != Settlement::Void && lp_done && lp_fees > 0 && holder_legs > 0,
        "LP claims a remainder with fees before finalize on a Yes/No market"
    );
    kani::cover!(
        kind == Settlement::Void && dust == (legs + 1) / 2 && dust > 0,
        "void dust reaches the (H + 1) / 2 bound"
    );
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::solver(cadical)]
fn proof_settlement_conserves_n1() {
    settlement_conserves::<1>(MAX_SETS);
}

#[kani::proof]
#[kani::unwind(4)]
#[kani::solver(cadical)]
fn proof_settlement_conserves_n2() {
    settlement_conserves::<2>(SMALL_BOUND);
}

#[kani::proof]
#[kani::unwind(5)]
#[kani::solver(cadical)]
fn proof_settlement_conserves_n3() {
    settlement_conserves::<3>(SMALL_BOUND);
}

/// Inductive step for any number of holders: if
/// `paid_out + settle_upper(outstanding) + lp_claim <= sets_minted` holds
/// before one `redeem` or `claim_pool_remainder`, it holds after, and
/// `finalize_residual` succeeds in both states. Together with the base case
/// (nothing paid, share invariant) this extends the bounded
/// `proof_settlement_conserves_n*` harnesses to every H.
#[kani::proof]
#[kani::unwind(1)]
#[kani::solver(cadical)]
fn proof_settlement_step_preserves_bound() {
    let kind = any_settlement();
    // All counters are non-negative and <= MAX_SETS: `sets_minted` by the
    // `buy` cap, the rest because they are slices of it (`redeem` decrements
    // outstanding by a position that is part of it; `paid_out` is bounded by
    // the invariant itself).
    let sets_minted = any_shares();
    let outstanding_yes = any_shares();
    let outstanding_no = any_shares();
    let paid_out = any_shares();
    let lp_claimed: bool = kani::any();
    let (reserve_yes, reserve_no) = if lp_claimed {
        // `claim_pool_remainder` zeroes both reserves when it sets
        // `lp_claimed`.
        (0, 0)
    } else {
        (any_shares(), any_shares())
    };
    let lp_fees = any_shares();
    let mut l = SettleLedger {
        sets_minted,
        outstanding_yes,
        outstanding_no,
        reserve_yes,
        reserve_no,
        paid_out,
        fees_paid: 0,
        lp_fees,
        lp_claimed,
        tracked: true,
    };
    let bound = |l: &SettleLedger| -> i128 {
        let lp = if l.lp_claimed {
            0
        } else {
            settle_value(kind, l.reserve_yes, l.reserve_no).unwrap()
        };
        l.paid_out + settle_upper(kind, l.outstanding_yes, l.outstanding_no).unwrap() + lp
    };
    // Induction hypothesis.
    assume(bound(&l) <= l.sets_minted);
    assert!(finalize_residual(&l, kind).is_ok());

    if kani::any::<bool>() {
        // `redeem`: the position is part of the outstanding shares (`buy` /
        // `sell` / `split` / `merge` update both together).
        let yes = any_shares();
        let no = any_shares();
        assume(yes <= l.outstanding_yes && no <= l.outstanding_no);
        apply_redeem(&mut l, kind, yes, no).expect("in-domain redeem never fails");
    } else {
        // `claim_pool_remainder` rejects a second claim (`AlreadyClaimed`).
        assume(!l.lp_claimed);
        apply_pool_claim(&mut l, kind).expect("first pool claim never fails");
    }
    assert!(bound(&l) <= l.sets_minted, "invariant preserved");
    let (_, _, dust) = finalize_residual(&l, kind).expect("residual stays non-negative");
    assert!(dust >= 0);
    kani::cover!(
        kind == Settlement::Void && bound(&l) == l.sets_minted && l.paid_out > 0,
        "step reaches the invariant's boundary"
    );
}

/// `redeem_many` folds `batch_redeem_step` over ascending market ids; the
/// result must equal three independent `redeem` calls on fresh copies of
/// the same ledgers (same final ledgers, same total).
#[kani::proof]
#[kani::unwind(4)]
fn proof_batch_equals_sequential() {
    const H: usize = 3;
    let mut base = [SettleLedger {
        sets_minted: 0,
        outstanding_yes: 0,
        outstanding_no: 0,
        reserve_yes: 0,
        reserve_no: 0,
        paid_out: 0,
        fees_paid: 0,
        lp_fees: 0,
        lp_claimed: false,
        tracked: true,
    }; H];
    let mut legs = [(Settlement::Yes, 0i128, 0i128); H];
    for i in 0..H {
        // Each market: counters bounded by MAX_SETS (`buy` cap). `tracked`
        // is symbolic: legacy markets without a `Settle` entry can appear in
        // the same batch (`load_settle_opt` returns None).
        base[i].sets_minted = any_shares();
        base[i].outstanding_yes = any_shares();
        base[i].outstanding_no = any_shares();
        base[i].paid_out = any_shares();
        base[i].tracked = kani::any();
        let yes = any_shares();
        let no = any_shares();
        // The holder's position is part of that market's outstanding shares.
        assume(yes <= base[i].outstanding_yes && no <= base[i].outstanding_no);
        assume(yes > 0 || no > 0); // `NothingToRedeem` skips empty positions
        legs[i] = (any_settlement(), yes, no);
    }

    let mut batch = base;
    let mut total: i128 = 0;
    for i in 0..H {
        let (kind, yes, no) = legs[i];
        total = batch_redeem_step(total, &mut batch[i], kind, yes, no).expect("fold never fails");
    }

    let mut seq_total: i128 = 0;
    for i in 0..H {
        let (kind, yes, no) = legs[i];
        let mut fresh = base[i];
        seq_total += apply_redeem(&mut fresh, kind, yes, no).expect("redeem never fails");
        assert!(fresh == batch[i], "same ledger");
    }
    assert!(total == seq_total, "same total");
    kani::cover!(
        total > 0 && batch[0].tracked && !batch[1].tracked,
        "mixed tracked and legacy markets in one batch"
    );
}
