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
//! - See `docs/fpmm-economics.md` for the proofs of the rounding, LP-loss and
//!   no-arbitrage claims made here (checked by `model/fpmm_bounds.py`).
//! - `MAX_SETS` bounds market size so that any product of two quantities
//!   (both <= 1e15) is <= 1e30, far below `i128::MAX` (~1.7e38). Every
//!   multiplication is still `checked_*` as a second line of defence.
//!
//! Headroom for `calc_sell_shares`: with b = shares_in + r_sold + r_other
//! and every term <= MAX_SETS = 1e15, b <= 3e15 and b^2 <= 9e30. The
//! discriminant D = b^2 - 4*r_other*shares_in fits in u128 (max ~3.4e38).
//! The 256-bit widening issue must revisit this bound if MAX_SETS grows.

pub const BPS: i128 = 10_000;
pub const MAX_SETS: i128 = 1_000_000_000_000_000; // 1e15 = 100M USDC (7 dp)
pub const MIN_PROB_BPS: u32 = 100; // 1%
pub const MAX_PROB_BPS: u32 = 9_900; // 99%

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
pub struct SellSharesQuote {
    pub collateral_out: i128,
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
/// To sell an exact share count, prefer the on-chain `sell_shares` entrypoint
/// (see `calc_sell_shares`). This function remains for backward compatibility.
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

/// Integer square root of a `u128`, floored, exact for every input
/// (`isqrt(n)^2 <= n < (isqrt(n)+1)^2`). Newton iteration seeded from a
/// bit-length upper bound, so it converges monotonically down to the floor.
/// Seeding at or below the root would let Newton converge from below and
/// return floor+1, which would break the pool-favouring correction in
/// `calc_sell_shares`.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // shift = ceil(bit_len(n) / 2), so 1 << shift >= sqrt(n).
    let shift = (128 - n.leading_zeros() + 1) / 2;
    let mut x = 1u128 << shift;
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Sell an exact `shares_in` count of the outcome whose pool reserve is
/// `r_sold`, returning the collateral the seller receives. This is the
/// on-chain inverse of `calc_sell`: it solves for the gross sets burned
/// such that the constant-product invariant is preserved after the seller gives
/// `shares_in` shares and the pool removes `gross` complete sets.
///
/// Derivation: we want `x` (gross) such that
///   (r_sold + shares_in - x) * (r_other - x) = r_sold * r_other
/// Expanding gives the quadratic x^2 - b*x + r_other*shares_in = 0 with
/// b = r_sold + shares_in + r_other. The smaller root is
///   x0 = (b - sqrt(b*b - 4*r_other*shares_in)) / 2
///
/// Pool-favouring rounding: isqrt rounds down, so x0 can overshoot the
/// real root by at most one. We decrement x while the invariant would drop,
/// guaranteeing new_sold * new_other >= r_sold * r_other. This loop runs
/// at most twice: the real root is in [x0-1, x0], and the invariant is
/// monotone in x on [0, min(shares_in, r_other)), so at most one step
/// from x0 reaches the greatest x satisfying the invariant.
///
/// Because the pool removes at least the gross that `calc_sell` would
/// charge for the same `shares_in`, the seller never receives more
/// collateral than the curve allows.
pub fn calc_sell_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<SellSharesQuote, MathError> {
    if shares_in <= 0 || r_sold <= 0 || r_other <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    // b = r_sold + shares_in + r_other, all terms <= MAX_SETS, so b <= 3e15.
    let b = r_sold
        .checked_add(shares_in.checked_add(r_other).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?;
    // D = b^2 - 4*r_other*shares_in. b^2 <= 9e30 and 4*r_other*shares_in <= 4e30,
    // both well within u128 (max ~3.4e38).
    let b2 = (b as u128)
        .checked_mul(b as u128)
        .ok_or(MathError::Overflow)?;
    let four_r_shares = (r_other as u128)
        .checked_mul(shares_in as u128)
        .ok_or(MathError::Overflow)?
        .checked_mul(4)
        .ok_or(MathError::Overflow)?;
    let d = b2
        .checked_sub(four_r_shares)
        .ok_or(MathError::Overflow)?;
    let sqrt_d = isqrt(d);
    let mut x = ((b as u128) - sqrt_d) / 2;
    // Pool-favouring correction: decrement while the invariant would drop.
    // The products are at most 1e30 and fit in i128.
    while x > 0 {
        let new_sold = r_sold
            .checked_add(shares_in)
            .ok_or(MathError::Overflow)?
            - x as i128;
        let new_other = r_other - x as i128;
        let left = new_sold
            .checked_mul(new_other)
            .ok_or(MathError::Overflow)?;
        let right = r_sold
            .checked_mul(r_other)
            .ok_or(MathError::Overflow)?;
        if left >= right {
            break;
        }
        x -= 1;
    }
    if x == 0 || x >= (r_other as u128) {
        return Err(MathError::InsufficientLiquidity);
    }
    let x = x as i128;
    // Fee rounds up, as in calc_buy.
    let collateral_out = mul_div_floor(x, BPS - fee_bps as i128, BPS)?;
    let fee = x - collateral_out;
    if collateral_out <= 0 {
        return Err(MathError::InvalidInput);
    }
    let new_sold = r_sold
        .checked_add(shares_in)
        .ok_or(MathError::Overflow)?
        - x;
    let new_other = r_other - x;
    Ok(SellSharesQuote {
        collateral_out,
        fee,
        gross: x,
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
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::string::ToString;

    fn isqrt_exact(n: u128) {
        let x = isqrt(n);
        assert!(
            x.checked_mul(x).unwrap() <= n,
            "isqrt lower bound failed for {}",
            n
        );
        if let Some(next) = x.checked_add(1) {
            if let Some(sq) = next.checked_mul(next) {
                assert!(n < sq, "isqrt upper bound failed for {}", n);
            }
        }
    }

    #[test]
    fn isqrt_exact_for_boundaries() {
        for n in 0u128..=128 {
            isqrt_exact(n);
        }
        for root in [10u128, 100u128, 1_000_000u128] {
            isqrt_exact(root * root);
            isqrt_exact(root * root - 1);
            isqrt_exact(root * root + 1);
        }
        // (3e15)^2 = 9e30, the largest product we allow.
        let max = (3_000_000_000_000_000u128);
        isqrt_exact(max * max);
        isqrt_exact(max * max - 1);
        isqrt_exact(max * max + 1);
        isqrt_exact(u128::MAX);
        isqrt_exact(u128::MAX - 1);
    }

    #[test]
    fn sell_shares_example_matches_model() {
        // 1000/1000 pool, sell 212 shares, no fee.
        let q = calc_sell_shares(1000, 1000, 212, 0).unwrap();
        assert_eq!(q.gross, 100);
        assert_eq!(q.collateral_out, 100);
        assert_eq!(q.fee, 0);
        assert_eq!(q.new_reserve_sold, 1112);
        assert_eq!(q.new_reserve_other, 900);
    }

    // Linear congruential generator for reproducible property tests.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(144269);
            self.0
        }
        fn range(&mut self, lo: i128, hi: i128) -> i128 {
            lo + (self.next() as i128) % (hi - lo + 1)
        }
    }

    #[test]
    fn sell_shares_k_never_decreases() {
        let mut rng = Lcg(0xdeadbeef);
        for _ in 0..2000 {
            let r_sold = rng.range(1, 1_000_000);
            let r_other = rng.range(1, 1_000_000);
            let shares_in = rng.range(1, r_sold);
            let fee_bps = rng.range(0, 1000) as u32;
            if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
                let left = q.new_reserve_sold * q.new_reserve_other;
                let right = r_sold * r_other;
                assert!(left >= right, "k decreased");
            }
        }
    }

    #[test]
    fn sell_shares_never_pays_more_than_calc_sell() {
        let mut rng = Lcg(0xcafe_babe_1234);
        for _ in 0..2000 {
            let r_sold = rng.range(1, 1_000_000);
            let r_other = rng.range(1, 1_000_000);
            let shares_in = rng.range(1, r_sold);
            let fee_bps = rng.range(0, 1000) as u32;
            if let Ok(q) = calc_sell_shares(r_sold, r_other, shares_in, fee_bps) {
                if let Ok(back) = calc_sell(r_sold, r_other, q.collateral_out, fee_bps) {
                    assert!(
                        back.shares_in <= shares_in,
                        "calc_sell charged less than shares_in"
                    );
                }
            }
        }
    }

    #[test]
    fn sell_shares_at_max_sets_no_overflow() {
        let q = calc_sell_shares(MAX_SETS, MAX_SETS, MAX_SETS / 2, 500).unwrap();
        assert!(q.collateral_out > 0);
        assert!(q.new_reserve_sold > 0);
        assert!(q.new_reserve_other > 0);
    }

    #[test]
    fn sell_shares_rejects_zero_collateral() {
        // Tiny sell whose collateral floors to 0 must revert.
        assert_eq!(
            calc_sell_shares(1_000_000, 1_000_000, 1, 0),
            Err(MathError::InvalidInput),
        );
    }

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
}