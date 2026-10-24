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

pub const BPS: i128 = 10_000;
pub const MAX_SETS: i128 = 1_000_000_000_000_000_000; // 1e15 = 100M USDC (7 dp)
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

/// Integer square root (Newton's method), mirroring `agents/core/fpmm.ts::isqrt`.
/// Returns `InvalidInput` for negative input.
pub fn isqrt(n: i128) -> Result<i128, MathError> {
    if n < 0 {
        return Err(MathError::InvalidInput);
    }
    if n < 2 {
        return Ok(n);
    }
    let mut x = n;
    // `(x + 1) / 2` overflows when x == i128::MAX; this is the same value.
    let mut y = x / 2 + x % 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    Ok(x)
}

/// Off-chain inverse of [`calc_sell`]: how many complete sets (`gross`) the
/// pool must burn so that selling exactly `shares_in` shares balances the
/// constant-product invariant, ignoring the contract's integer rounding.
///
/// Solves `(shares_in + r_sold - x)(r_other - x) = r_sold * r_other` for the
/// smaller root of `x` (the pool never burns more than `r_other`). Mirrors
/// `model/fpmm_model.py::gross_for_shares` and
/// `agents/core/fpmm.ts::grossForShares`. This is **not** used on-chain: the
/// contract takes an exact collateral amount to avoid a square root.
pub fn gross_for_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<i128, MathError> {
    if shares_in <= 0 || r_sold <= 0 || r_other <= 0 || (fee_bps as i128) >= BPS {
        return Err(MathError::InvalidInput);
    }
    let a = shares_in.checked_add(r_sold).ok_or(MathError::Overflow)?;
    let b = a.checked_add(r_other).ok_or(MathError::Overflow)?;
    let b_sq = mul(b, b)?;
    let four_rs = mul(4, mul(r_other, shares_in)?)?;
    let disc = b_sq.checked_sub(four_rs).ok_or(MathError::Overflow)?;
    if disc < 0 {
        return Err(MathError::InsufficientLiquidity);
    }
    let root = isqrt(disc)?;
    let gross = (b - root) / 2;
    if gross <= 0 || gross >= r_other {
        return Err(MathError::InsufficientLiquidity);
    }
    Ok(gross)
}

/// Estimated `collateral_out` for selling `shares_in` shares, rounded down
/// (pool-favoring). Mirrors the off-chain helpers in Python and TypeScript.
pub fn collateral_out_for_shares(
    r_sold: i128,
    r_other: i128,
    shares_in: i128,
    fee_bps: u32,
) -> Result<i128, MathError> {
    let gross = gross_for_shares(r_sold, r_other, shares_in, fee_bps)?;
    mul_div_floor(gross, BPS - fee_bps as i128, BPS)
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

/// Maximum complete sets a holder can merge: `min(yes, no)`.
///
/// Pure helper so frontends and agents can offer "merge all" without
/// duplicating the clip logic. Negative inputs are clipped to zero so the
/// result is always non-negative and safe to pass to `merge`.
pub fn merge_max(yes: i128, no: i128) -> i128 {
    let y = if yes < 0 { 0 } else { yes };
    let n = if no < 0 { 0 } else { no };
    if y < n {
        y
    } else {
        n
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::string::ToString;

    #[test]
    fn buy_example_matches_model() {
        // 1000/1000 pool, buy 100 with no fee -> 190 shares, reserves 910/1100
        let q = calc_buy(1000, 1000, 100, 0).unwrap();
        assert_eq(q.shares_out, 190);
        assert_eq(q.new_reserve_bought, 910);
        assert_eq(q.new_reserve_other, 1100);
    }

    #[test]
    fn sell_example_matches_model() {
        let q = calc_sell(1000, 1000, 100, 0).unwrap();
        assert_eq(q.shares_in, 212);
        assert_eq(q.gross, 100);
        assert_eq(q.new_reserve_sold, 1112);
        assert_eq(q.new_reserve_other, 900);
    }

    #[test]
    fn seed_opens_at_requested_probability() {
        for p in [100u32, 2500, 5000, 7300, 9900] {
            let s = seed_reserves(10_000_000_000, p).unwrap();
            let price = price_yes_bps(s.reserve_yes, s.reserve_no).unwrap();
            assert!((price - p as i128).abs() <= 1, "p={p} price={price}");
            assert_eq(s.creator_yes == 0 || s.creator_no == 0, true);
        }
    }

    #[test]
    fn k_never_decreases_and_round_trip_never_profits() {
        // tiny LCG so this stays no_std-friendly
        let mut x: u64 = 0x9E37_79B9_7FA7C15;
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
        assert_eq(settle_value(Settlement::Void, 3, 4), 3);
        assert!(settle_value(Settlement::Void, 5, 5) <= 5);
    }

    #[test]
    fn split_fee_sums_exactly() {
        let (fee, share) = (101, 3300);
        let (proto, lp) = split_fee(fee, share).unwrap();
        assert_eq(proto + lp, fee);
        assert_eq(split_fee(fee, BPS as u32).unwrap(), (fee, 0));
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
    fn inverse_matches_reference_examples() {
        // Worked examples pinned by the Python and TypeScript mirrors.
        assert_eq!(gross_for_shares(1_000, 1_000, 212, 0).unwrap(), 100);
        assert_eq!(
            collateral_out_for_shares(1_000, 1_000, 212, 0).unwrap(),
            100
        );
        let q = calc_sell(10_000, 20_000, 1_000, 100).unwrap();
        let out = collateral_out_for_shares(10_000, 20_000, q.shares_in, 100).unwrap();
        let back = calc_sell(10_000, 20_000, out, 100).unwrap();
        assert!(back.shares_in <= q.shares_in + 1);
    }

    #[test]
    fn isqrt_exact_squares() {
        for n in [0i128, 1, 2, 3, 4, 9, 15, 16, 17, 10_000, 10_000_000_000] {
            let r = isqrt(n).unwrap();
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n} r={r}");
        }
        assert_eq!(
            isqrt(i128::MAX).unwrap().checked_mul(1).unwrap(),
            13_043_817_825_332_782_212
        );
        assert_eq!(isqrt(-1), Err(MathError::InvalidInput));
    }

    #[test]
    fn shared_vectors_match() {
        // Kept in sync with `model/fpmm_model.py`, `agents/core/fpmm.test.ts`
        // and the differential harness. Any porting mistake on these
        // boundary-heavy inputs makes at least one language fail.
        let raw = include_str!("../../../scripts/fpmm-diff/vectors.jsonl");
        for (line_no, line) in raw.lines().enumerate() {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let f = v["fn"].as_str().unwrap();
            let a = v["args"].as_array().unwrap();
            let arg = |i: usize| -> i128 { a[i].as_str().unwrap().parse().unwrap() };
            let actual = match f {
                "calc_buy" => {
                    let q = calc_buy(arg(0), arg(1), arg(2), arg(3) as u32).unwrap();
                    serde_json::json!({
                        "shares_out": q.shares_out.to_string(),
                        "fee": q.fee.to_string(),
                        "net": q.net.to_string(),
                        "new_reserve_bought": q.new_reserve_bought.to_string(),
                        "new_reserve_other": q.new_reserve_other.to_string(),
                    })
                }
                "calc_sell" => {
                    let q = calc_sell(arg(0), arg(1), arg(2), arg(3) as u32).unwrap();
                    serde_json::json!({
                        "shares_in": q.shares_in.to_string(),
                        "fee": q.fee.to_string(),
                        "gross": q.gross.to_string(),
                        "new_reserve_sold": q.new_reserve_sold.to_string(),
                        "new_reserve_other": q.new_reserve_other.to_string(),
                    })
                }
                "seed_reserves" => {
                    let s = seed_reserves(arg(0), arg(1) as u32).unwrap();
                    serde_json::json!({
                        "reserve_yes": s.reserve_yes.to_string(),
                        "reserve_no": s.reserve_no.to_string(),
                        "creator_yes": s.creator_yes.to_string(),
                        "creator_no": s.creator_no.to_string(),
                    })
                }
                "mul_div_floor" => {
                    serde_json::json!({"value": mul_div_floor(arg(0), arg(1), arg(2)).unwrap().to_string()})
                }
                "mul_div_ceil" => {
                    serde_json::json!({"value": mul_div_ceil(arg(0), arg(1), arg(2)).unwrap().to_string()})
                }
                "price_yes_bps" => {
                    serde_json::json!({"value": price_yes_bps(arg(0), arg(1)).unwrap().to_string()})
                }
                "settle_value" => {
                    let kind = match a[0].as_str().unwrap() {
                        "yes" => Settlement::Yes,
                        "no" => Settlement::No,
                        "void" => Settlement::Void,
                        other => panic!("line {line_no}: unknown settlement {other}"),
                    };
                    serde_json::json!({"value": settle_value(kind, arg(1), arg(2)).to_string()})
                }
                "gross_for_shares" => {
                    serde_json::json!({"gross": gross_for_shares(arg(0), arg(1), arg(2), arg(3) as u32).unwrap().to_string()})
                }
                "collateral_out_for_shares" => {
                    serde_json::json!({"collateral_out": collateral_out_for_shares(arg(0), arg(1), arg(2), arg(3) as u32).unwrap().to_string()})
                }
                other => panic!("line {line_no}: unknown fn {other}"),
            };
            assert_eq!(
                &actual,
                &v["ok"],
                "shared vector line {} failed",
                line_no + 1
            );
        }
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