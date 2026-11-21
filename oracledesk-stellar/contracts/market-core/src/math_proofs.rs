//! Kani harnesses for the FPMM pricing engine.
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
    calc_buy, calc_sell, calc_sell_shares, isqrt, mul_div_ceil, mul_div_floor, price_yes_bps,
    seed_reserves, BPS, MAX_PROB_BPS, MAX_SETS, MIN_PROB_BPS,
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
    assume!(r > 0);
    assume!(r <= MAX_SETS);
}

/// `buy` rejects a fee above `MAX_FEE_BPS`. `calc_sell` itself accepts a
/// wider domain (any fee `< BPS`) but the contract never passes one.
fn assume_contract_fee(fee_bps: u32) {
    assume!(fee_bps <= CONTRACT_MAX_FEE_BPS);
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_floor_bounds() {
    // The lemma layer: a, b ∈ [0, MAX_SETS] and c ∈ [1, 2*MAX_SETS] cover
    // every call site (reserve sums are at most 2*MAX_SETS).
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume!(a >= 0 && a <= MAX_SETS);
    assume!(b >= 0 && b <= MAX_SETS);
    assume!(c >= 1 && c <= 2 * MAX_SETS);

    let q = mul_div_floor(a, b, c).expect("product fits: 1e15 * 1e15 << i128::MAX");
    let p = a * b; // bounded by 1e30
    let qc = q * c; // q = floor(p/c), so q*c <= p <= 1e30
    assert!(qc <= p);
    assert!(p - qc < c);
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_ceil_bounds() {
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume!(a >= 0 && a <= MAX_SETS);
    assume!(b >= 0 && b <= MAX_SETS);
    assume!(c >= 1 && c <= 2 * MAX_SETS);

    let q = mul_div_ceil(a, b, c).expect("product fits: 1e15 * 1e15 << i128::MAX");
    let p = a * b;
    let qc = q * c; // <= p + c - 1 <= 1e30 + 2e15
    assert!(qc >= p);
    assert!(qc - p < c);
    if p % c == 0 {
        assert!(q == p / c);
    }
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_mul_div_rejects_invalid_inputs() {
    let a: i128 = kani::any();
    let b: i128 = kani::any();
    let c: i128 = kani::any();
    assume!(a < 0 || b < 0 || c <= 0);
    assert!(mul_div_floor(a, b, c).is_err());
    assert!(mul_div_ceil(a, b, c).is_err());
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
    assume!(collateral_in > 0 && collateral_in <= MAX_SETS);
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
    assume!(collateral_in > 0 && collateral_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_buy(r_bought, r_other, collateral_in, fee_bps) {
        // Both products are <= 2e30, well inside i128.
        let k_before = r_bought * r_other;
        let k_after = q.new_reserve_bought * q.new_reserve_other;
        assert!(k_after >= k_before, "buy must never decrease k");
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
    assume!(collateral_out > 0 && collateral_out <= MAX_SETS);
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
    assume!(collateral_out > 0 && collateral_out <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_sell(r_sold, r_other, collateral_out, fee_bps) {
        let k_before = r_sold * r_other;
        let k_after = q.new_reserve_sold * q.new_reserve_other;
        assert!(k_after >= k_before, "sell must never decrease k");
    }
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_hi_price() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume!(seed >= CONTRACT_MIN_SEED && seed <= MAX_SETS);
    assume!(p >= 5_000 && p >= MIN_PROB_BPS && p <= MAX_PROB_BPS);
    let s = seed_reserves(seed, p).expect("in-domain seed");
    let price = price_yes_bps(s.reserve_yes, s.reserve_no).expect("positive reserves");
    assert!((price - p as i128).abs() <= 1);
    // p >= 5000 keeps all `seed` in the NO reserve, so the creator keeps
    // only YES shares (none at exactly 5000, where both are zero).
    assert_eq!(s.reserve_no, seed);
    assert_eq!(s.creator_no, 0);
    assert!(s.creator_yes >= 0);
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_lo_price() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume!(seed >= CONTRACT_MIN_SEED && seed <= MAX_SETS);
    assume!(p >= MIN_PROB_BPS && p < 5_000);
    let s = seed_reserves(seed, p).expect("in-domain seed");
    let price = price_yes_bps(s.reserve_yes, s.reserve_no).expect("positive reserves");
    assert!((price - p as i128).abs() <= 1);
    // p < 5000 keeps all `seed` in the YES reserve, so the creator keeps
    // only NO shares.
    assert_eq!(s.reserve_yes, seed);
    assert_eq!(s.creator_yes, 0);
    assert!(s.creator_no >= 0);
}

#[kani::proof]
#[kani::unwind(1)]
fn proof_seed_reserves_rejects_out_of_domain() {
    let seed: i128 = kani::any();
    let p: u32 = kani::any();
    assume!(seed <= 0 || p < MIN_PROB_BPS || p > MAX_PROB_BPS);
    assert!(seed_reserves(seed, p).is_err());
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
    assume!(collateral_in > 0 && collateral_in <= MAX_SETS);
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
}

/// `isqrt` is the floor of the square root: it never overshoots, and the next
/// integer always does. Inputs are symbolic u64 widened to u128, which covers
/// every discriminant reachable from in-domain reserves and share counts.
#[kani::proof]
#[kani::unwind(8)]
fn proof_isqrt_floor() {
    let n: u64 = kani::any();
    let n = n as u128;
    let r = isqrt(n);
    assert!(r * r <= n);
    if let Some(next) = r.checked_add(1) {
        assert!(n < next * next);
    }
}

/// The exact-share sell path must not reduce the constant product. The
/// pool-favouring correction loop exists precisely to enforce this.
#[kani::proof]
#[kani::unwind(3)]
fn proof_calc_sell_shares_k_monotone() {
    let r_sold: i128 = kani::any();
    let r_other: i128 = kani::any();
    let shares_in: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_sold);
    assume_reserve(r_other);
    assume!(shares_in > 0 && shares_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
        let k_before = r_sold * r_other;
        let k_after = q.new_reserve_sold * q.new_reserve_other;
        assert!(k_after >= k_before, "sell_shares must never decrease k");
    }
}

/// The exact-share quote never pays out more collateral than the forward
/// `calc_sell` would charge for the same share count. Feeding the quoted
/// payout back through `calc_sell` must therefore never require more shares
/// than the seller supplied (one unit of rounding tolerance is enough).
#[kani::proof]
#[kani::unwind(3)]
fn proof_calc_sell_shares_le_calc_sell() {
    let r_sold: i128 = kani::any();
    let r_other: i128 = kani::any();
    let shares_in: i128 = kani::any();
    let fee_bps: u32 = kani::any();
    assume_reserve(r_sold);
    assume_reserve(r_other);
    assume!(shares_in > 0 && shares_in <= MAX_SETS);
    assume_contract_fee(fee_bps);

    if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
        assert!(q.collateral_out <= shares_in);
        assert!(q.new_reserve_sold > r_sold);
        assert!(q.new_reserve_other < r_other);
        if let Ok(back) = calc_sell(r_sold, r_other, q.collateral_out, fee_bps) {
            assert!(
                back.shares_in <= shares_in + 1,
                "exact-share quote must not overpay"
            );
        }
    }
}
