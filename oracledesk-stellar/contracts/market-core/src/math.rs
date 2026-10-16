//! Pure integer math for a binary fixed-product market maker (FPMM).
//!
//! No Soroban types in here, so `cargo test` exercises it natively and
//! `model/fpmm_model.py` mirrors it line by line for property testing.
//!
//! Conventions
//! - All amounts are non-negative `i128` in collateral base units
//!   (USDC on Stellar = 7 decimals, so 1 USDC = 10_000_000).
//! - Rounding always favours the pool: fees round up, shares out round down,
//!   shares in round up. This is what keeps the pool invariant `k = r_yes * r_no`
//!   non-decreasing and blocks dust-splitting attacks.
//! - `MAX_SETS` bounds market size so that any product of two quantities
//!   (both <= 1e15) is <= 1e30, far below `i128::MAX` (~1.7e38). Every
//!   multiplication is still `checked_*` as a second line of defence.

pub const BPS: i128 = 10_000;
pub const MAX_SETS: i128 = 1_000_000_000_000_000; // 1e15 = 100M USDC (7 dp)
pub const MIN_PROB_BPS: u32 = 100; // 1%
pub const MAX_PROB_BPS: u32 = 9_900; // 99%
/// Longest dynamic-fee ramp: 30 days. Caps how far before close an admin
/// can start the time component.
pub const MAX_RAMP_SECS: u64 = 30 * 86_400;
/// Largest skew multiplier: 1_000 means the skew term grows 1 bp per
/// 1_000 bps (10 points) of price distance from 50%, up to 5x the
/// multiplier at the extreme prices.
pub const MAX_SKEW_MULT_BPS: u32 = 1_000;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MathError {
    Overflow,
    InvalidInput,
    InsufficientLiquidity,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Settlement {
    Yes,
    No,
    Void,
    /// Scalar market: LONG pays `floor(yes * p / BPS)`, SHORT pays
    /// `floor(no * (BPS - p) / BPS)`, `p` in bps in `0..=BPS`.
    /// `Scalar(BPS)` is equivalent to `Yes`, `Scalar(0)` to `No`.
    Scalar(u32),
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct BuyQuote {
    pub shares_out: i128,
    pub fee: i128,
    /// Collateral that actually mints complete sets (`collateral_in - fee`).
    pub net: i128,
    pub new_reserve_bought: i128,
    pub new_reserve_other: i128,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SellQuote {
    pub shares_in: i128,
    pub fee: i128,
    /// Complete sets burned from the pool (`collateral_out + fee`).
    pub gross: i128,
    pub new_reserve_sold: i128,
    pub new_reserve_other: i128,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SeedReserves {
    pub reserve_yes: i128,
    pub reserve_no: i128,
    /// Outcome shares handed back to the market creator so the pool opens at
    /// the requested probability (only one of these is non-zero).
    pub creator_yes: i128,
    pub creator_no: i128,
}

fn mul(a: i128, b: i128) -> Result<i128, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

/// floor(a * b / c)
pub fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(a, b)? / c)
}

/// ceil(a * b / c), written to avoid overflowing on `p + c - 1`.
pub fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, MathError> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(MathError::InvalidInput);
    }
    let p = mul(a, b)?;
    let q = p / c;
    Ok(if p % c != 0 { q + 1 } else { q })
}

/// Spot price of YES in bps: r_no / (r_yes + r_no).
pub fn price_yes_bps(reserve_yes: i128, reserve_no: i128) -> Result<i128, MathError> {
    let sum = reserve_yes
        .checked_add(reserve_no)
        .ok_or(MathError::Overflow)?;
    if sum <= 0 {
        return Err(MathError::InsufficientLiquidity);
    }
    mul_div_floor(reserve_no, BPS, sum)
}

/// YES price in bps of the pool **after** applying an outcome-relative
/// reserve update (the `new_reserve_*` pair of a `BuyQuote`/`SellQuote`).
/// Follows `reserves_for`'s convention: pass `outcome_is_yes = false` for a
/// NO trade, where `r_after` is the NO reserve.
pub fn price_after(
    outcome_is_yes: bool,
    r_after: i128,
    r_other_after: i128,
) -> Result<i128, MathError> {
    if outcome_is_yes {
        price_yes_bps(r_after, r_other_after)
    } else {
        price_yes_bps(r_other_after, r_after)
    }
}

/// Pure mirror of the contract's `FeeSchedule` (see `lib.rs`), phrased with
/// plain numbers so `model/fpmm_model.py` and `agents/core/fpmm.ts` can
/// reproduce `effective_fee_bps` bit-for-bit. Field order mirrors the XDR.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct FeeScheduleM {
    pub base_bps: u32,
    pub max_bps: u32,
    pub ramp_secs: u64,
    pub skew_mult_bps: u32,
}

/// The fee rate a trade pays under `s` at time `now` with the pool at
/// `(r_yes, r_no)`: `min(max, base + t + skew)` where
///
/// - `t` ramps linearly from 0 to `max - base` over the last `ramp_secs`
///   before `close` (0 when `ramp_secs == 0` or the window has not opened;
///   `max - base` once `now >= close`), and
/// - `skew = |p - 5_000| * skew_mult_bps / 1_000` with `p` the floored
///   pre-trade YES price — so a balanced pool pays `base` and a one-sided
///   pool pays up to `base + 5 * skew_mult_bps`.
///
/// Both floors round **down**, i.e. towards the trader: unlike the pool
/// math (`calc_buy`/`calc_sell` always round for the pool) the fee only
/// needs to be deterministic across the contract, the Python model and the
/// TS mirror, and a sub-bp gift to the trader cannot break the invariant.
/// The pre-trade price keeps the fee independent of the trade being priced
/// (a post-trade price would be circular with `calc_buy`).
///
/// Guarantees `base <= result <= max` for every schedule with
/// `base <= max < BPS`; any other schedule is rejected. `now >= close`
/// (possible in quotes) clamps to the ramp end. All arithmetic is `i128`,
/// so no input pair can overflow.
pub fn effective_fee_bps(
    s: &FeeScheduleM,
    now: u64,
    close: u64,
    r_yes: i128,
    r_no: i128,
) -> Result<u32, MathError> {
    if s.base_bps > s.max_bps || s.max_bps as i128 >= BPS {
        return Err(MathError::InvalidInput);
    }
    let base = s.base_bps as i128;
    let max = s.max_bps as i128;
    let delta = max - base;
    let t = if s.ramp_secs == 0 {
        0
    } else {
        let ramp = s.ramp_secs as i128;
        let into_ramp = if now >= close {
            ramp
        } else {
            s.ramp_secs.saturating_sub(close - now) as i128
        };
        mul_div_floor(into_ramp, delta, ramp)?
    };
    let p = price_yes_bps(r_yes, r_no)?;
    let d = (p - 5_000).abs();
    let skew = mul_div_floor(d, s.skew_mult_bps as i128, 1_000)?;
    let total = base
        .checked_add(t)
        .and_then(|v| v.checked_add(skew))
        .ok_or(MathError::Overflow)?;
    Ok(if total > max {
        max as u32
    } else {
        total as u32
    })
}

/// Pool opens at `yes_bps` probability with `seed` complete sets minted.
/// The pool keeps fewer of the *likelier* outcome; the creator keeps the rest.
pub fn seed_reserves(seed: i128, yes_bps: u32) -> Result<SeedReserves, MathError> {
    if seed <= 0 || !(MIN_PROB_BPS..=MAX_PROB_BPS).contains(&yes_bps) {
        return Err(MathError::InvalidInput);
    }
    let p = yes_bps as i128;
    let (reserve_yes, reserve_no) = if p >= BPS / 2 {
        (mul_div_floor(seed, BPS - p, p)?, seed)
    } else {
        (seed, mul_div_floor(seed, p, BPS - p)?)
    };
    if reserve_yes <= 0 || reserve_no <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(SeedReserves {
        reserve_yes,
        reserve_no,
        creator_yes: seed - reserve_yes,
        creator_no: seed - reserve_no,
    })
}

/// Buy `collateral_in` worth of the outcome whose pool reserve is `r_bought`.
///
/// 1. fee = ceil(in * fee_bps / BPS); net = in - fee
/// 2. mint `net` complete sets into the pool: r_other += net
/// 3. pool keeps r_bought' = ceil(r_bought * r_other / r_other')  (k preserved)
/// 4. buyer receives r_bought + net - r_bought'
pub fn calc_buy(
    r_bought: i128,
    r_other: i128,
    collateral_in: i128,
    fee_bps: u32,
) -> Result<BuyQuote, MathError> {
    if collateral_in <= 0 || r_bought <= 0 || r_other <= 0 {
        return Err(MathError::InvalidInput);
    }
    let fee = mul_div_ceil(collateral_in, fee_bps as i128, BPS)?;
    let net = collateral_in - fee;
    if net <= 0 {
        return Err(MathError::InvalidInput);
    }
    let new_other = r_other.checked_add(net).ok_or(MathError::Overflow)?;
    let new_bought = mul_div_ceil(r_bought, r_other, new_other)?;
    let shares_out = r_bought.checked_add(net).ok_or(MathError::Overflow)? - new_bought;
    if shares_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(BuyQuote {
        shares_out,
        fee,
        net,
        new_reserve_bought: new_bought,
        new_reserve_other: new_other,
    })
}

/// Sell shares of the outcome with pool reserve `r_sold` for an exact
/// `collateral_out` (Gnosis-style, so no square root on-chain).
///
/// 1. gross = ceil(out * BPS / (BPS - fee_bps)); fee = gross - out
/// 2. burn `gross` complete sets from the pool: r_other -= gross
/// 3. pool must end at r_sold' = ceil(r_sold * r_other / r_other')
/// 4. seller gives r_sold' + gross - r_sold shares
///
/// To sell an exact share count, the frontend inverts this off-chain
/// (quadratic, see `model/fpmm_model.py::gross_for_shares`) and passes the
/// result as `collateral_out` with a `max_shares_in` slippage bound.
pub fn calc_sell(
    r_sold: i128,
    r_other: i128,
    collateral_out: i128,
    fee_bps: u32,
) -> Result<SellQuote, MathError> {
    if collateral_out <= 0 || r_sold <= 0 || r_other <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    let gross = mul_div_ceil(collateral_out, BPS, BPS - fee_bps as i128)?;
    let fee = gross - collateral_out;
    if gross >= r_other {
        return Err(MathError::InsufficientLiquidity);
    }
    let new_other = r_other - gross;
    let new_sold = mul_div_ceil(r_sold, r_other, new_other)?;
    let shares_in = new_sold.checked_add(gross).ok_or(MathError::Overflow)? - r_sold;
    if shares_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(SellQuote {
        shares_in,
        fee,
        gross,
        new_reserve_sold: new_sold,
        new_reserve_other: new_other,
    })
}

/// True when a buy's average execution price `collateral_in / shares_out`
/// (fees included) is at most `limit_bps` per share (1.0 = BPS).
/// Compared by cross-multiplication so division rounding cannot flip the
/// decision; exact equality passes. `shares_out` comes from `calc_buy`, so
/// it is always > 0 in practice.
pub fn buy_within_limit(
    collateral_in: i128,
    shares_out: i128,
    limit_bps: u32,
) -> Result<bool, MathError> {
    if collateral_in < 0 || shares_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(collateral_in, BPS)? <= mul(shares_out, limit_bps as i128)?)
}

/// True when a sell's average execution price `collateral_out / shares_in`
/// is at least `limit_bps` per share. Exact equality passes; a zero limit is
/// trivially satisfied (`collateral_out >= 0`), which buys the caller no
/// protection — see `sell_v2`'s docs.
pub fn sell_within_limit(
    collateral_out: i128,
    shares_in: i128,
    limit_bps: u32,
) -> Result<bool, MathError> {
    if collateral_out < 0 || shares_in <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(mul(collateral_out, BPS)? >= mul(shares_in, limit_bps as i128)?)
}

/// Splits a gross fee between the protocol and the LP.
///
/// The protocol portion rounds **up** so `protocol + lp == fee` exactly (no
/// rounding leakage): the LP absorbs at most one sub-unit of dust, and the
/// default `protocol_share_bps = BPS` is exact (all protocol, 0 to the LP).
pub fn split_fee(fee: i128, protocol_share_bps: u32) -> Result<(i128, i128), MathError> {
    if fee < 0 || protocol_share_bps as i128 > BPS {
        return Err(MathError::InvalidInput);
    }
    let protocol = mul_div_ceil(fee, protocol_share_bps as i128, BPS)?;
    Ok((protocol, fee - protocol))
}

/// Collateral value of a (yes, no) share pair once a market is final.
/// Void pays 0.5 per share, which keeps total payouts <= sets minted.
pub fn settle_value(kind: Settlement, yes: i128, no: i128) -> i128 {
    match kind {
        Settlement::Yes => yes,
        Settlement::No => no,
        Settlement::Void => (yes + no) / 2,
        Settlement::Scalar(p) => scalar_payout(p, yes, no),
    }
}

/// Collateral value of a (yes, no) share pair in a scalar market whose
/// resolved value maps to `payout_long_bps` LONG per complete set. Both legs
/// floor independently, so no holder ever receives more than their exact
/// rational share, and since `Σyes == Σno == sets_minted` across holders and
/// the pool the total paid out never exceeds `sets_minted`.
///
/// `payout_long_bps` must be `<= BPS`; the market layer validates that in
/// `resolve_scalar` before any payout can be settled.
pub fn scalar_payout(payout_long_bps: u32, yes: i128, no: i128) -> i128 {
    let p = payout_long_bps as i128;
    let long = yes * p / BPS;
    let short = no * (BPS - p) / BPS;
    long + short
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_example_matches_model() {
        // 1000/1000 pool, buy 100 with no fee -> 190 shares, reserves 910/1100
        let q = calc_buy(1000, 1000, 100, 0).unwrap();
        assert_eq!(q.shares_out, 190);
        assert_eq!(q.new_reserve_bought, 910);
        assert_eq!(q.new_reserve_other, 1100);
    }

    #[test]
    fn sell_example_matches_model() {
        let q = calc_sell(1000, 1000, 100, 0).unwrap();
        assert_eq!(q.shares_in, 212);
        assert_eq!(q.gross, 100);
        assert_eq!(q.new_reserve_sold, 1112);
        assert_eq!(q.new_reserve_other, 900);
    }

    #[test]
    fn seed_opens_at_requested_probability() {
        for p in [100u32, 2500, 5000, 7300, 9900] {
            let s = seed_reserves(10_000_000_000, p).unwrap();
            let price = price_yes_bps(s.reserve_yes, s.reserve_no).unwrap();
            assert!((price - p as i128).abs() <= 1, "p={p} price={price}");
            assert!(s.creator_yes == 0 || s.creator_no == 0);
        }
    }

    #[test]
    fn k_never_decreases_and_round_trip_never_profits() {
        // tiny LCG so this stays no_std-friendly
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let ry = 1_000_000 + next() % 1_000_000_000;
            let rn = 1_000_000 + next() % 1_000_000_000;
            let amt = 1 + next() % (ry.min(rn) / 2);
            let fee = (next() % 300) as u32;
            let k0 = ry * rn;
            let q = calc_buy(ry, rn, amt, fee).unwrap();
            assert!(q.new_reserve_bought * q.new_reserve_other >= k0);
            // getting `amt` back out costs at least the shares the buy paid out
            if let Ok(s) = calc_sell(q.new_reserve_bought, q.new_reserve_other, amt, fee) {
                assert!(s.shares_in >= q.shares_out, "free money");
            }
        }
    }

    #[test]
    fn void_never_overpays() {
        assert_eq!(settle_value(Settlement::Void, 3, 4), 3);
        assert!(settle_value(Settlement::Void, 5, 5) <= 5);
    }

    #[test]
    fn scalar_extremes_match_binary() {
        for (yes, no) in [(0i128, 7i128), (3, 4), (1_000_000, 250_000)] {
            assert_eq!(
                settle_value(Settlement::Scalar(BPS as u32), yes, no),
                settle_value(Settlement::Yes, yes, no)
            );
            assert_eq!(
                settle_value(Settlement::Scalar(0), yes, no),
                settle_value(Settlement::No, yes, no)
            );
        }
    }

    #[test]
    fn scalar_rounding_favours_pool() {
        let mut x: u64 = 0x0DDC_0FFE_E0DD_F00D;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let yes = next() % 1_000_000_000_000;
            let no = next() % 1_000_000_000_000;
            let p = (next() % (BPS + 1)) as u32;
            let paid = scalar_payout(p, yes, no);
            // floor + floor never exceeds the exact rational amount
            assert!(paid * BPS <= yes * p as i128 + no * (BPS - p as i128));
        }
    }

    #[test]
    fn scalar_payout_never_exceeds_sets() {
        let mut x: u64 = 0x5EED_5EED_5EED_5EED;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let sets = 1 + next() % 1_000_000_000_000;
            let p = (next() % (BPS + 1)) as u32;
            // three holders split `sets` complete sets independently per leg
            let (mut rest_y, mut rest_n) = (sets, sets);
            let mut total: i128 = 0;
            for h in 0..3 {
                let take_y = if h == 2 {
                    rest_y
                } else {
                    next() % (rest_y + 1)
                };
                let take_n = if h == 2 {
                    rest_n
                } else {
                    next() % (rest_n + 1)
                };
                rest_y -= take_y;
                rest_n -= take_n;
                total += scalar_payout(p, take_y, take_n);
            }
            assert!(total <= sets, "scalar overpaid: {total} > {sets} at p={p}");
        }
    }

    #[test]
    fn split_fee_sums_exactly() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (x >> 33) as i128
        };
        for _ in 0..2_000 {
            let fee = next() % 1_000_000_000_000;
            let share = (next() % (BPS + 1)) as u32;
            let (protocol, lp) = split_fee(fee, share).unwrap();
            assert_eq!(protocol + lp, fee, "fee={fee} share={share}");
            assert!(protocol >= 0 && lp >= 0);
            // protocol rounds up: never below the exact proportional share
            assert!(protocol * BPS >= fee * share as i128);
        }
    }

    #[test]
    fn split_fee_default_is_all_protocol() {
        assert_eq!(split_fee(12_345, 10_000).unwrap(), (12_345, 0));
        assert_eq!(split_fee(12_345, 0).unwrap(), (0, 12_345));
        assert_eq!(split_fee(0, 3_333).unwrap(), (0, 0));
    }

    #[test]
    fn buy_within_limit_boundaries() {
        // avg price exactly 1.0: passing costs the full limit, passes
        assert!(buy_within_limit(100, 100, 10_000).unwrap());
        // cheaper than the limit
        assert!(buy_within_limit(100, 101, 10_000).unwrap());
        // one unit above the limit fails
        assert!(!buy_within_limit(101, 100, 10_000).unwrap());
        // 100 in -> 200 shares = 0.5 per share, exactly at 5_000 bps
        assert!(buy_within_limit(100, 200, 5_000).unwrap());
        assert!(!buy_within_limit(101, 200, 5_000).unwrap());
    }

    #[test]
    fn sell_within_limit_boundaries() {
        assert!(sell_within_limit(100, 100, 10_000).unwrap());
        assert!(!sell_within_limit(99, 100, 10_000).unwrap());
        // 100 out from 200 shares = 0.5 per share, exactly at 5_000 bps
        assert!(sell_within_limit(100, 200, 5_000).unwrap());
        assert!(!sell_within_limit(100, 201, 5_000).unwrap());
        // a zero limit is trivially satisfied
        assert!(sell_within_limit(0, 1, 0).unwrap());
    }

    #[test]
    fn price_after_maps_both_sides() {
        assert_eq!(price_after(true, 1_000, 1_000).unwrap(), 5_000);
        assert_eq!(price_after(false, 1_000, 1_000).unwrap(), 5_000);
        // NO buy pushing NO reserve to 910 with 1100 YES: YES price is
        // 1100 / (1100 + 910), i.e. price_yes_bps(yes, no)
        assert_eq!(
            price_after(false, 910, 1_100).unwrap(),
            price_yes_bps(1_100, 910).unwrap()
        );
    }

    fn sched(base_bps: u32, max_bps: u32, ramp_secs: u64, skew_mult_bps: u32) -> FeeScheduleM {
        FeeScheduleM {
            base_bps,
            max_bps,
            ramp_secs,
            skew_mult_bps,
        }
    }

    #[test]
    fn effective_fee_within_bounds() {
        let mut x: u64 = 0xFEE1_0BEE_FEE1_0BEE;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x >> 33
        };
        for _ in 0..2_000 {
            let base = (next() % 1_001) as u32;
            let max = base + (next() % (1_001 - base as u64)) as u32;
            let s = sched(
                base,
                max,
                next() % (MAX_RAMP_SECS + 1),
                (next() % (MAX_SKEW_MULT_BPS as u64 + 1)) as u32,
            );
            let close = 1_000_000 + next() % 1_000_000_000;
            let now = next();
            let r_yes = 1 + (next() % 1_000_000_000_000) as i128;
            let r_no = 1 + (next() % 1_000_000_000_000) as i128;
            let fee = effective_fee_bps(&s, now, close, r_yes, r_no).unwrap();
            assert!(fee >= base, "fee {fee} < base {base}");
            assert!(fee <= max, "fee {fee} > max {max}");
            assert!(max <= 1_000);
        }
    }

    #[test]
    fn effective_fee_ramp_monotonic_in_time() {
        let s = sched(100, 800, 10_000, 250);
        let (close, r_yes, r_no) = (500_000u64, 1_000i128, 3_000i128);
        let mut prev = 0u32;
        let mut t = close - 20_000;
        while t <= close + 5_000 {
            let fee = effective_fee_bps(&s, t, close, r_yes, r_no).unwrap();
            assert!(fee >= prev, "fee fell from {prev} to {fee} at t={t}");
            prev = fee;
            t += 137;
        }
        assert_eq!(prev, 800, "past close the fee clamps to max");
    }

    #[test]
    fn effective_fee_symmetric_in_skew() {
        let s = sched(200, 1_000, 0, 100);
        // exactly representable ratios: p and 10_000 - p both hold, so the
        // floored distance d is identical on either side and the fee must
        // be exactly equal
        for (a, b) in [
            (1_000i128, 3_000i128),
            (900, 1_100),
            (5_000, 5_000),
            (1, 4),
            (7, 3),
            (1, 1),
        ] {
            assert_eq!(
                effective_fee_bps(&s, 0, 1, a, b).unwrap(),
                effective_fee_bps(&s, 0, 1, b, a).unwrap(),
                "asymmetric at {a}/{b}"
            );
        }
        // inexact ratios can shift the floored price distance by 1, which
        // the floored scaling bounds by one bp while skew_mult <= 1_000
        let mut x: u64 = 0x5CE1_5CE1_5CE1_5CE1;
        let mut next = move || {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            x >> 33
        };
        for _ in 0..2_000 {
            let a = 1 + (next() % 1_000_000_000_000) as i128;
            let b = 1 + (next() % 1_000_000_000_000) as i128;
            let f1 = effective_fee_bps(&s, 0, 1, a, b).unwrap();
            let f2 = effective_fee_bps(&s, 0, 1, b, a).unwrap();
            assert!((f1 as i64 - f2 as i64).abs() <= 1, "{a}/{b}: {f1} vs {f2}");
        }
    }

    #[test]
    fn effective_fee_zero_ramp() {
        let s = sched(120, 900, 0, 300);
        let far = effective_fee_bps(&s, 0, u64::MAX, 1_000, 1_000).unwrap();
        let at_close = effective_fee_bps(&s, 5_000_000, 5_000_000, 1_000, 1_000).unwrap();
        let past = effective_fee_bps(&s, 6_000_000, 5_000_000, 1_000, 1_000).unwrap();
        assert_eq!(far, 120);
        assert_eq!(far, at_close);
        assert_eq!(far, past);
    }

    #[test]
    fn effective_fee_rejects_unbounded_schedule() {
        assert_eq!(
            effective_fee_bps(&sched(500, 400, 0, 0), 0, 1, 1, 1),
            Err(MathError::InvalidInput)
        );
        // max must stay strictly below BPS (calc_sell requires fee < BPS)
        assert_eq!(
            effective_fee_bps(&sched(0, 10_000, 0, 0), 0, 1, 1, 1),
            Err(MathError::InvalidInput)
        );
    }

    #[test]
    fn effective_fee_matches_fixtures() {
        // Shared cross-language table (also read by model/fpmm_model.py and
        // agents/core/fpmm.ts): one row per fixture, nine numbers —
        // [base_bps, max_bps, ramp_secs, skew_mult_bps,
        //  now, close, r_yes, r_no, expected_fee_bps]
        let raw = include_str!("../../../model/fee_fixtures.json");
        let mut nums = [0i128; 512];
        let mut n = 0usize;
        let mut cur: Option<i128> = None;
        for b in raw.bytes() {
            if b.is_ascii_digit() {
                let d = (b - b'0') as i128;
                cur = Some(cur.map_or(d, |v| v * 10 + d));
            } else if let Some(v) = cur.take() {
                assert!(n < 512, "fee_fixtures.json holds too many numbers");
                nums[n] = v;
                n += 1;
            }
        }
        if let Some(v) = cur.take() {
            assert!(n < 512, "fee_fixtures.json holds too many numbers");
            nums[n] = v;
            n += 1;
        }
        assert!(
            n > 0 && n.is_multiple_of(9),
            "expected 9 numbers per row, got {n}"
        );
        for row in nums[..n].chunks(9) {
            let s = sched(row[0] as u32, row[1] as u32, row[2] as u64, row[3] as u32);
            let fee = effective_fee_bps(&s, row[4] as u64, row[5] as u64, row[6], row[7]).unwrap();
            assert_eq!(fee, row[8] as u32, "fixture {row:?}");
        }
    }
}
